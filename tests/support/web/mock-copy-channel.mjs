// Copy a simulated channel without touching the input graph. The real host
// additionally loads effect state and validates the resulting audio graph.
export function copyMockChannel(graph, channels, primary, sidechains, sourceId, makeId = () => crypto.randomUUID()) {
  if (!Array.isArray(graph?.chains) || !Array.isArray(channels) || graph.chains.length !== channels.length) throw new TypeError("invalid graph");
  const chains = structuredClone(graph.chains);
  const nextChannels = structuredClone(channels);
  const index = chains.findIndex(chain => chain.id === sourceId);
  if (index < 0 || nextChannels[index]?.id !== sourceId) throw new RangeError("channel not found");
  const used = new Set(chains.map(chain => chain.id));
  const id = Array.from({ length: 32 }, (_, n) => n).find(n => !used.has(n));
  if (id === undefined) throw new RangeError("channel capacity");
  const identities = chains.flatMap(chain => (chain.rack ?? []).map(slot => slot.instance)).concat(sidechains ?? []);
  if (identities.some(value => !Number.isSafeInteger(value) || value < 0)) throw new RangeError("invalid instance");
  let last = Math.max(0, ...identities);
  const copy = structuredClone(chains[index]);
  copy.id = id;
  copy.chain_uuid = makeId();
  copy.source_uuid = null;
  copy.purpose = null;
  const mapping = new Map();
  for (const slot of copy.rack ?? []) {
    if (mapping.has(slot.instance) || last >= Number.MAX_SAFE_INTEGER) throw new RangeError("instance capacity");
    mapping.set(slot.instance, ++last);
    slot.instance = last;
    slot.effect_uuid = makeId();
  }
  for (const send of copy.sends ?? []) {
    send.id = makeId();
    if (send.dest?.kind === "chain" && send.dest.id === sourceId) send.dest.id = id;
    if (send.dest?.kind === "sidechain" && mapping.has(send.dest.instance)) send.dest.instance = mapping.get(send.dest.instance);
  }
  for (let i = 0; i < chains.length; i++) {
    if (i === index) continue;
    const sends = chains[i].sends ?? [];
    const additions = [];
    for (const send of sends) {
      const target = send.dest?.kind === "chain" && send.dest.id === sourceId;
      const side = send.dest?.kind === "sidechain" && mapping.has(send.dest.instance);
      if (!target && !side) continue;
      const duplicate = structuredClone(send);
      duplicate.id = makeId();
      if (target) duplicate.dest.id = id;
      else duplicate.dest.instance = mapping.get(send.dest.instance);
      additions.push(duplicate);
    }
    if (sends.length + additions.length > 256) throw new RangeError("send capacity");
    chains[i].sends = [...sends, ...additions];
    nextChannels[i].sends = structuredClone(chains[i].sends);
  }
  const copiedChannel = { ...nextChannels[index], id, chain_uuid: copy.chain_uuid, source_uuid: null, purpose: null, rack: structuredClone(copy.rack ?? []), sends: structuredClone(copy.sends ?? []) };
  chains.splice(index + 1, 0, copy);
  nextChannels.splice(index + 1, 0, copiedChannel);
  const additions = [];
  const nextSidechains = [...(sidechains ?? [])];
  for (const [oldId, newId] of mapping) {
    if (primary?.[oldId]) additions.push([newId, structuredClone(primary[oldId])]);
    if (nextSidechains.includes(oldId)) nextSidechains.push(newId);
  }
  return { chains, channels: nextChannels, primary: additions, sidechains: nextSidechains, mapping };
}
