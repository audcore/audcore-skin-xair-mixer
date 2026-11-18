export function normalizeLink(value) {
  const group = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z][0-9]+$/.test(group) ? group : null;
}

// Managed route bridges are not effect rows. The suffix follows Rust's u8 parser.
export function isRouteBridge(slot) {
  const match = /^@wdm-(?:play|rec)-(\+?\d+)$/.exec(slot.alias ?? "");
  return !!match && Number(match[1]) <= 255;
}

export function linkedSlotRows(graph, id) {
  const source = graph?.chains?.find(chain => chain.id === id);
  if (!source) return [];
  const group = normalizeLink(source.mute_group);
  const enabled = !!group && (graph.link_groups?.[group]?.slots ?? false);
  const peers = enabled ? graph.chains.filter(chain => normalizeLink(chain.mute_group) === group) : [source];
  const visible = chain => (chain.rack ?? []).filter(slot => !isRouteBridge(slot));
  const effects = visible(source);
  if (!enabled) return effects;
  const count = Math.max(0, ...peers.map(chain => visible(chain).length));
  const result = Array(count).fill(null);
  let cursor = 0;
  for (let ordinal = 0; ordinal < effects.length; ordinal++) {
    const slot = effects[ordinal];
    const stored = graph.link_slots?.[slot.instance];
    const desired = Number.isSafeInteger(stored) && stored >= 0 ? stored : cursor;
    const index = Math.max(cursor, Math.min(desired, count - (effects.length - ordinal)));
    result[index] = slot;
    cursor = index + 1;
  }
  return result;
}
