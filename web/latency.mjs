import { isRouteBridge } from "./link-slots.mjs";

// Match the built-in console's effect-chain and uncompensated route delays.
// Unknown effect information contributes zero until the host publishes it.
export function createLatencyCalculator(graph, effectInfo, keepBypassLatency = true) {
  const chains = graph?.chains ?? [];
  const byId = new Map(chains.map(chain => [chain.id, chain]));
  const racks = new Map(chains.map(chain => [chain.id, (chain.rack ?? []).reduce((sum, effect) =>
    sum + (effect.offline || (!keepBypassLatency && !isRouteBridge(effect) && (effect.bypass || chain.fx_bypass))
      ? 0 : effectInfo?.[effect.instance]?.latencySamples ?? 0), 0)]));
  const incoming = new Map();
  for (const source of chains) for (const send of source.sends ?? []) {
    if (send.enabled === false || send.dest?.kind !== "chain") continue;
    const entries = incoming.get(send.dest.id) ?? [];
    entries.push([source.id, send.tap]);
    incoming.set(send.dest.id, entries);
  }
  const routes = new Map();
  function route(channelId, visiting) {
    if (visiting.has(channelId)) return [0, 0, true];
    if (routes.has(channelId)) return routes.get(channelId);
    const channel = byId.get(channelId);
    if (!channel) return [0, 0, false];
    visiting.add(channelId);
    const taps = (channel.inputs?.length || channel.virtual_input != null) ? [0] : [];
    let cyclic = false;
    for (const [source, tap] of incoming.get(channelId) ?? []) {
      const [upstream, , cycle] = route(source, visiting);
      cyclic ||= cycle;
      taps.push(upstream + (tap === 0 ? 0 : racks.get(source)));
    }
    visiting.delete(channelId);
    const maximum = taps.length ? taps.reduce((a, b) => Math.max(a, b)) : 0;
    const minimum = taps.length ? taps.reduce((a, b) => Math.min(a, b)) : 0;
    const result = [maximum, taps.length > 1 ? maximum - minimum : 0, cyclic];
    // Cyclic results depend on which upstream node was visited first; caching
    // them would let one channel's traversal change another channel's value.
    if (!cyclic) routes.set(channelId, result);
    return result;
  }
  const rate = Math.max(1, graph?.sample_rate ?? 48000);
  const format = value => (value >= 10 ? value.toFixed(0) : value.toFixed(1));
  return id => {
    const channel = byId.get(id);
    const total = format((racks.get(id) ?? 0) / rate * 1000);
    const mismatch = format(graph?.pdc ? 0 : route(id, new Set())[1] / rate * 1000);
    return {
      total: Number(total) > 0 ? `${channel?.ignore_latency ? "⚡︎" : ""}${total}ms` : "",
      mismatch: Number(mismatch) >= 1 ? `⚠${mismatch}` : "",
      ignored: Boolean(channel?.ignore_latency),
      severe: Number(total) >= 10
    };
  };
}

export function channelLatency(graph, effectInfo, id) {
  return createLatencyCalculator(graph, effectInfo)(id);
}

// Gain, meter and other unrelated changes must not traverse the routing graph.
export function latencyNeedsUpdate(event) {
  if (!event || ["snapshot", "structure", "effect_batch", "order"].includes(event.type)) return true;
  if (event.type === "change") return ["graph", "effectInfo", "latencyPolicy"].includes(event.key);
  if (event.type === "patch") return ["graph", "channels", "effectInfo", "latencyPolicy"].some(key => Object.hasOwn(event.changes ?? {}, key));
  if (event.type === "channel") return ["inputs", "virtual_input", "rack", "sends", "ignore_latency", "fx_bypass"].includes(event.graphField);
  return false;
}
