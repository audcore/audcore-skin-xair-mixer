import { normalizeLink, isRouteBridge, linkedSlotRows } from "./link-slots.mjs";
export { normalizeLink, isRouteBridge, linkedSlotRows } from "./link-slots.mjs";

// Host-side draft for the channel-link panel. No changes are published until apply.
const defaults = Object.freeze({ mute: true, gain: false, fx: false, slots: false, solo: false });
const fields = Object.keys(defaults);

export function createLinkDraft(graph, id) {
  const chain = graph?.chains?.find(item => item.id === id);
  if (!chain) throw new RangeError("channel not found");
  const original = structuredClone(graph.link_groups ?? {});
  const group = normalizeLink(chain.mute_group);
  return { id, group, originalGroup: group, original, groups: structuredClone(original) };
}

export function selectLinkGroup(draft, value) {
  if (typeof value !== "string" || (value.trim() && !normalizeLink(value))) throw new RangeError("invalid link group");
  draft.group = normalizeLink(value);
}

export function setLinkControl(draft, field, value) {
  if (!fields.includes(field) || typeof value !== "boolean" || !draft.group) throw new RangeError("invalid link control");
  draft.groups[draft.group] = { ...defaults, ...draft.groups[draft.group], [field]: value };
}

export function linkControls(draft) {
  return { ...defaults, ...draft.groups[draft.group] };
}

export function applyLinkDraft(graph, channels, draft) {
  const source = graph?.chains?.find(item => item.id === draft.id);
  if (!source || !channels?.some(item => item.id === draft.id)) throw new RangeError("channel not found");
  const groups = structuredClone(graph.link_groups ?? {});
  // Merge only controls the user changed; other updates may arrive while open.
  for (const [key, controls] of Object.entries(draft.groups)) {
    const original = { ...defaults, ...draft.original[key] };
    const edited = { ...defaults, ...controls };
    const current = { ...defaults, ...groups[key] };
    const changed = fields.filter(field => edited[field] !== original[field]);
    if (!changed.length) continue;
    for (const field of changed) {
      if (current[field] !== original[field] && current[field] !== edited[field]) throw new Error("链接设置已改变，请重试");
      current[field] = edited[field];
    }
    groups[key] = current;
  }
  const currentGroup = normalizeLink(source.mute_group);
  const changedGroup = draft.group !== draft.originalGroup;
  if (changedGroup && currentGroup !== draft.originalGroup && currentGroup !== draft.group) throw new Error("通道分组已改变，请重试");
  const group = changedGroup ? draft.group : currentGroup;
  const peer = graph.chains.find(item => item.id !== draft.id && group && normalizeLink(item.mute_group) === group);
  const desiredMute = Boolean(peer?.mute ?? source.mute);
  const muteUpdates = new Map();
  if (group && (groups[group]?.mute ?? true)) for (const item of graph.chains) {
    const itemGroup = item.id === draft.id ? group : normalizeLink(item.mute_group);
    if (itemGroup === group) muteUpdates.set(item.id, desiredMute);
    else if (!desiredMute && itemGroup && itemGroup[0] === group[0] && (groups[itemGroup]?.mute ?? true)) muteUpdates.set(item.id, true);
  }
  const update = (item, muteField) => item.id === draft.id || muteUpdates.has(item.id)
    ? { ...item, ...(item.id === draft.id ? { mute_group: group } : {}), ...(muteUpdates.has(item.id) ? { [muteField]: muteUpdates.get(item.id) } : {}) }
    : item;
  return { graph: { ...graph, link_groups: groups, chains: graph.chains.map(item => update(item, "mute")) }, channels: channels.map(item => update(item, "muted")) };
}


export function linkedSlotTargets(graph, id, instance) {
  const source = graph?.chains?.find(chain => chain.id === id);
  if (!source) return [];
  const group = normalizeLink(source.mute_group);
  const enabled = !!group && (graph.link_groups?.[group]?.slots ?? false);
  const peers = enabled ? graph.chains.filter(chain => normalizeLink(chain.mute_group) === group) : [source];
  const position = linkedSlotRows(graph, id).findIndex(slot => slot?.instance === instance);
  if (position < 0) return [];
  return peers.flatMap(chain => {
    const slot = linkedSlotRows(graph, chain.id)[position];
    return slot ? [{ id: chain.id, instance: slot.instance }] : [];
  });
}


// Swap visible positions, retaining bridge slots and unrelated position records.
export function moveLinkedSlot(graph, id, instance, to) {
  const source = graph?.chains?.find(chain => chain.id === id);
  const group = normalizeLink(source?.mute_group);
  if (!source || !group || !graph.link_groups?.[group]?.slots) throw new RangeError("linked slots unavailable");
  const rows = linkedSlotRows(graph, id);
  const from = rows.findIndex(slot => slot?.instance === instance);
  if (from < 0 || !Number.isInteger(to) || to < 0 || to >= rows.length) throw new RangeError("invalid linked slot position");
  if (from === to) return graph;
  [rows[from], rows[to]] = [rows[to], rows[from]];
  const existing = new Set(graph.chains.flatMap(chain => (chain.rack ?? []).map(slot => String(slot.instance))));
  const positions = Object.fromEntries(Object.entries(graph.link_slots ?? {}).filter(([key]) => existing.has(key)));
  rows.forEach((slot, index) => { if (slot) positions[slot.instance] = index; });
  const sorted = rows.filter(Boolean);
  let next = 0;
  const rack = source.rack.map(slot => isRouteBridge(slot) ? slot : sorted[next++]);
  return { ...graph, link_slots: positions, chains: graph.chains.map(chain => chain.id === id ? { ...chain, rack } : chain) };
}
