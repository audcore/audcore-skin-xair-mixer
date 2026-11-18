import { isRouteBridge } from "./link-slots.mjs";

// Match the host's routing constraints for the drag preview. The host checks
// its current graph and live sidechain capability again when adding the send.
export function channelSendTargets(graph, sourceId, sidechains, t = text => text) {
  const chains = graph?.chains ?? [];
  const source = chains.find(chain => chain.id === sourceId);
  if (!source || (source.sends?.length ?? 0) >= 256) return [];

  const blocked = sendFeedbackSources(chains, sourceId);

  const sent = new Set();
  for (const send of source.sends ?? []) {
    if (send.dest?.kind === "chain") sent.add(`chain:${send.dest.id}`);
    if (send.dest?.kind === "sidechain") sent.add(`sidechain:${send.dest.instance}`);
  }
  const channelTargets = [];
  const effectTargets = [];
  for (const chain of chains) {
    if (blocked.has(chain.id)) continue;
    const id = `chain:${chain.id}`;
    if (!sent.has(id) && !chain.rack?.some(slot => slot.alias?.startsWith("@wdm-rec-"))) {
      channelTargets.push({ id, label: chain.name || `${t("通道")} ${chain.id + 1}`, dest: { kind: "chain", id: chain.id } });
    }
    for (const slot of chain.rack ?? []) {
      const id = `sidechain:${slot.instance}`;
      if (sent.has(id) || slot.offline || isRouteBridge(slot) || !sidechains.has(slot.instance)) continue;
      effectTargets.push({ id, label: `${slot.alias || slot.name || slot.path || t("插件")} · ${t("侧链")}`, dest: { kind: "sidechain", instance: slot.instance } });
    }
  }
  return [...channelTargets, ...effectTargets];
}

export function sendFeedbackSources(chains, sourceId) {
  const effectOwners = new Map();
  const incoming = new Map(chains.map(chain => [chain.id, []]));
  for (const chain of chains) {
    for (const effect of chain.rack ?? []) effectOwners.set(effect.instance, chain.id);
  }
  for (const chain of chains) {
    for (const send of chain.sends ?? []) {
      if (send.enabled === false) continue;
      if (send.dest?.kind === "chain") incoming.get(send.dest.id)?.push(chain.id);
      if (send.dest?.kind === "sidechain") incoming.get(effectOwners.get(send.dest.instance))?.push(chain.id);
    }
  }
  const blocked = new Set([sourceId]);
  for (const id of blocked) {
    for (const upstream of incoming.get(id) ?? []) blocked.add(upstream);
  }
  return blocked;
}

// Same output overlap and mono rules as the host offer. The command still
// checks the live device binding before accepting a target.
export function outputSendTargets(graph, source) {
  if (!source || (source.sends?.length ?? 0) >= 256) return [];
  const targets = [];
  (graph?.output_pairs ?? []).forEach((_, pair) => {
    const dest = { kind: "output", pair };
    const modes = (source.channel_mode ?? 0) === 0 ? [null] : [null, 0, 1];
    for (const side of modes) {
      const overlaps = source.sends?.some(send => send.dest?.kind === "output" &&
        send.dest.pair === pair && (send.output_channel == null || side == null || send.output_channel === side));
      if (!overlaps) targets.push({ id: `output:${pair}${side == null ? "" : `:${side}`}`, dest, output_channel: side });
    }
  });
  return targets;
}
