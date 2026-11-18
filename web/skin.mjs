// Protocol error identifiers stay stable; visible text comes from the shared
// host catalog. Unknown errors are preserved so their details are not lost.
export function localizeHostError(message, translate) {
  const keys = {
    "channel IDs exhausted": "通道数量已满",
    "channel limit reached": "通道数量已满",
    "channel identity changed": "通道已变化，请重试",
    "effect identity changed": "工程已变化，请重试",
    "effect target changed": "工程已变化，请重试",
    "target rack changed": "工程已变化，请重试",
    "send route changed": "发送路由已变化，请重试",
    "sends changed; retry": "发送路由已变化，请重试",
    "graph changed; retry": "工程已变化，请重试",
    "snapshot required": "状态尚未同步，请稍候",
    "edit already pending": "请等待当前操作完成",
    "skin session inactive": "界面已休眠，请重试",
  };
  return translate(keys[message] ?? message);
}

// The skin receives authoritative snapshots and changes through the host API.
// The caller owns the returned cleanup function and invokes it on page teardown.
export async function mountSkin(host, render, onError = error => console.error(error), { borrowState = false, subscription } = {}) {
  let state = {};
  let revision = -1;
  let disposed = false;
  let recovering = false;
  let recovery = null;
  let recoveryEpoch = 0;
  function consistentChannels(channels, graph) {
    if (!Array.isArray(channels) || !graph || !Array.isArray(graph.chains)) return false;
    return channels.length === graph.chains.length &&
      channels.every((channel, index) => {
        const chain = graph.chains[index];
        if (!channel || channel.id !== chain?.id) return false;
        return ["chain_uuid", "source_uuid"].every(key => {
          const left = channel[key] ?? null;
          const right = chain[key] ?? null;
          return (left === null || typeof left === "string") && left === right;
        });
      }) &&
      new Set(channels.map(channel => channel.id)).size === channels.length;
  }
  function validRack(rack) {
    if (!Array.isArray(rack) || rack.length > 4096) return false;
    const seen = new Set();
    for (const slot of rack) {
      if (!slot || typeof slot !== "object" || Array.isArray(slot) ||
          !Number.isSafeInteger(slot.instance) || slot.instance < 0 || seen.has(slot.instance) ||
          (slot.alias != null && (typeof slot.alias !== "string" || new TextEncoder().encode(slot.alias).length > 4096)) ||
          ("bypass" in slot && typeof slot.bypass !== "boolean") ||
          ("offline" in slot && typeof slot.offline !== "boolean")) return false;
      seen.add(slot.instance);
    }
    return true;
  }
  function validLinkFields(graph) {
    const object = value => value && typeof value === "object" && !Array.isArray(value);
    const fields = ["mute", "gain", "fx", "slots", "solo"];
    if ("link_groups" in graph && (!object(graph.link_groups) || Object.entries(graph.link_groups).some(([key, value]) =>
      !key || new TextEncoder().encode(key).length > 256 || !object(value) ||
      Object.entries(value).some(([field, enabled]) => !fields.includes(field) || typeof enabled !== "boolean")))) return false;
    if ("link_slots" in graph && (!object(graph.link_slots) || Object.entries(graph.link_slots).some(([key, index]) =>
      !/^(0|[1-9][0-9]*)$/.test(key) || !Number.isSafeInteger(Number(key)) || !Number.isSafeInteger(index) || index < 0))) return false;
    return true;
  }
  function validStructure(snapshot) {
    if ("channels" in snapshot && (!Array.isArray(snapshot.channels) ||
        snapshot.channels.some(channel => !channel || !Number.isSafeInteger(channel.id) || channel.id < 0 || channel.id > 0xffffffff ||
          (channel.rack !== undefined && !validRack(channel.rack))) ||
        new Set(snapshot.channels.map(channel => channel.id)).size !== snapshot.channels.length)) return false;
    if (Array.isArray(snapshot.channels)) {
      const instances = new Set();
      for (const channel of snapshot.channels) for (const slot of channel.rack ?? []) {
        if (instances.has(slot.instance)) return false;
        instances.add(slot.instance);
      }
    }
    if ("graph" in snapshot && (!snapshot.graph || typeof snapshot.graph !== "object" ||
        Array.isArray(snapshot.graph) || !Array.isArray(snapshot.graph.chains) || !validLinkFields(snapshot.graph))) return false;
    return !(snapshot.graph && snapshot.channels) || consistentChannels(snapshot.channels, snapshot.graph);
  }
  function validPrimary(parameter) {
    return parameter && typeof parameter === "object" && !Array.isArray(parameter) &&
      Number.isSafeInteger(parameter.id) && parameter.id >= 0 && parameter.id <= 0xffffffff &&
      typeof parameter.label === "string" && parameter.label.length <= 256 && typeof parameter.units === "string" && parameter.units.length <= 64 &&
      [parameter.normalized, parameter.default_normalized].every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
      Number.isFinite(parameter.minimum) && Number.isFinite(parameter.maximum) && parameter.minimum < parameter.maximum &&
      Number.isFinite(parameter.step) && parameter.step > 0 && Number.isFinite(parameter.skew) && parameter.skew > 0 && typeof parameter.inverted === "boolean";
  }
  // Match the host's identity rules; an alias or slot position is not identity.
  function sameEffectIdentity(before, after) {
    const oldUuid = before.effect_uuid, newUuid = after.effect_uuid;
    if (typeof oldUuid === "string" && typeof newUuid === "string" && oldUuid.toUpperCase() !== newUuid.toUpperCase()) return false;
    const normalize = value => typeof value === "string" ? value.replaceAll("-", "").toUpperCase() : value ?? null;
    const oldFuid = before.fuid ?? null, newFuid = after.fuid ?? null;
    if (oldFuid !== null && newFuid !== null) return normalize(oldFuid) === normalize(newFuid);
    if ((oldFuid === null) !== (newFuid === null)) return (before.path ?? "") === (after.path ?? "") && (before.cid ?? null) === (after.cid ?? null);
    const oldCid = before.cid ?? null, newCid = after.cid ?? null;
    if (oldCid !== null && newCid !== null) return normalize(oldCid) === normalize(newCid);
    return oldCid === null && newCid === null && (before.path ?? "") === (after.path ?? "");
  }
  function retainLivePrimary(snapshot) {
    const previous = new Map((state.channels ?? []).flatMap(channel => (channel.rack ?? []).map(slot => [String(slot.instance), slot])));
    const instances = new Set(snapshot.channels.flatMap(channel => (channel.rack ?? []).filter(slot => {
      const before = previous.get(String(slot.instance));
      return before && sameEffectIdentity(before, slot);
    }).map(slot => String(slot.instance))));
    const primary = snapshot.primary === undefined ? undefined : Object.fromEntries(Object.entries(snapshot.primary).filter(([instance]) => instances.has(instance)));
    const missingEffects = snapshot.missingEffects === undefined ? undefined : Object.fromEntries(Object.entries(snapshot.missingEffects).filter(([instance]) => instances.has(instance)));
    const effectInfo = snapshot.effectInfo === undefined ? undefined : Object.fromEntries(Object.entries(snapshot.effectInfo).filter(([instance]) => instances.has(instance)));
    return { ...snapshot, ...(primary === undefined ? {} : { primary }), ...(missingEffects === undefined ? {} : { missingEffects }), ...(effectInfo === undefined ? {} : { effectInfo }) };
  }
  function validPrimarySnapshot(snapshot) {
    if (snapshot.effectInfo !== undefined) {
      if (!snapshot.effectInfo || typeof snapshot.effectInfo !== "object" || Array.isArray(snapshot.effectInfo) || !Array.isArray(snapshot.channels)) return false;
      const instances = new Set(snapshot.channels.flatMap(channel => (channel.rack ?? []).map(slot => String(slot.instance))));
      if (Object.entries(snapshot.effectInfo).some(([key, value]) => !instances.has(key) || !value || typeof value !== "object" || Array.isArray(value) ||
          typeof value.name !== "string" || !Number.isSafeInteger(value.latencySamples) || value.latencySamples < 0 ||
          typeof value.hasSidechain !== "boolean" || typeof value.hasEditor !== "boolean")) return false;
    }
    if (snapshot.missingEffects !== undefined) {
      if (!snapshot.missingEffects || typeof snapshot.missingEffects !== "object" || Array.isArray(snapshot.missingEffects) || !Array.isArray(snapshot.channels)) return false;
      const instances = new Set(snapshot.channels.flatMap(channel => (channel.rack ?? []).map(slot => String(slot.instance))));
      if (Object.entries(snapshot.missingEffects).some(([key, value]) => !instances.has(key) || value !== true)) return false;
    }
    if (snapshot.primary === undefined) return true;
    if (!snapshot.primary || typeof snapshot.primary !== "object" || Array.isArray(snapshot.primary)) return false;
    if (!Array.isArray(snapshot.channels)) return false;
    const instances = new Set(snapshot.channels.flatMap(channel => (channel.rack ?? []).map(slot => slot.instance)));
    return Object.entries(snapshot.primary).every(([key, parameter]) => {
      const instance = Number(key);
      return Number.isSafeInteger(instance) && instance >= 0 && String(instance) === key && validPrimary(parameter) && instances.has(instance);
    });
  }
  function resync() {
    if (!recovering) { recovering = true; recoveryEpoch++; }
    if (recovery || disposed) return;
    const started = recoveryEpoch;
    recovery = Promise.resolve().then(() => host.state.resync()).then(result => {
      if (recovering && recoveryEpoch === started && !disposed && result?.deferred !== true) throw new Error("resync completed without a snapshot");
    }).catch(error => {
      if (!disposed && recoveryEpoch === started) onError(error);
    }).finally(() => {
      recovery = null;
      // A valid snapshot can complete this recovery before its response. If a
      // new gap appears in between, it needs its own request once this ends.
      if (!disposed && recovering && recoveryEpoch !== started) resync();
    });
  }
  const unsubscribe = await host.state.subscribe(event => {
    if (disposed) return;
    if (!event || typeof event !== "object") { resync(); return; }
    if (event.type === "snapshot") {
      if (!Number.isSafeInteger(event.revision) || event.revision < revision || !event.state || typeof event.state !== "object" || Array.isArray(event.state) || !validStructure(event.state) || !validPrimarySnapshot(event.state)) {
        resync();
        return;
      }
      state = event.state;
      revision = event.revision;
      recovering = false;
    } else if (recovering) {
      // A failed resync remains pending logically; the next pushed event
      // retries it without polling or accepting an incomplete delta.
      if (!recovery) resync();
      return;
    } else if (event.type === "change" && event.revision === revision + 1) {
      const next = { ...state, [event.key]: event.value };
      if (["graph", "channels", "primary", "missingEffects", "effectInfo"].includes(event.key) &&
          (!validStructure(next) || !validPrimarySnapshot(next))) { resync(); return; }
      state = next;
      revision = event.revision;
    } else if (event.type === "patch" && event.revision === revision + 1) {
      if (!event.changes || typeof event.changes !== "object" || Array.isArray(event.changes)) {
        resync();
        return;
      }
      const next = { ...state, ...event.changes };
      if (["graph", "channels", "primary", "missingEffects", "effectInfo"].some(key => key in event.changes) &&
          (!validStructure(next) || !validPrimarySnapshot(next))) {
        resync();
        return;
      }
      state = next;
      revision = event.revision;
    } else if (event.type === "graph_patch" && event.revision === revision + 1) {
      const changes = event.changes;
      const object = value => value && typeof value === "object" && !Array.isArray(value);
      if (!object(state.graph) || !object(changes) || !Object.keys(changes).length ||
          Object.keys(changes).some(key => !["link_groups", "link_slots"].includes(key)) || !validLinkFields(changes)) {
        resync();
        return;
      }
      state = { ...state, graph: { ...state.graph, ...changes } };
      revision = event.revision;
    } else if (event.type === "effect_batch" && event.revision === revision + 1) {
      const seen = new Set();
      if (!Array.isArray(state.channels) || !Array.isArray(event.changes) || !event.changes.length ||
          event.changes.some(change => {
            if (!change || !Number.isSafeInteger(change.id) || seen.has(change.id) ||
                !state.channels.some(channel => channel.id === change.id) || !validRack(change.rack)) return true;
            seen.add(change.id);
            return false;
          })) { resync(); return; }
      const racks = new Map(event.changes.map(change => [change.id, change.rack]));
      const channels = state.channels.map(channel => racks.has(channel.id) ? { ...channel, rack: racks.get(channel.id) } : channel);
      let graph = state.graph;
      if (graph) {
        if (!Array.isArray(graph.chains) || [...racks.keys()].some(id => !graph.chains.some(channel => channel.id === id))) { resync(); return; }
        graph = { ...graph, chains: graph.chains.map(channel => racks.has(channel.id) ? { ...channel, rack: racks.get(channel.id) } : channel) };
      }
      const next = retainLivePrimary({ ...state, channels, ...(graph ? { graph } : {}) });
      if (!validStructure(next) || !validPrimarySnapshot(next)) { resync(); return; }
      state = next;
      revision = event.revision;
    } else if (event.type === "channel_batch" && event.revision === revision + 1) {
      const allowed = new Set(["solo", "solo_safe", "recording", "recording_stopping"]);
      const seen = new Set();
      if (!Array.isArray(state.channels) || !Array.isArray(event.changes) || !event.changes.length ||
          event.changes.some(change => {
            if (!change || !Number.isSafeInteger(change.id) || seen.has(change.id) ||
                !state.channels.some(channel => channel.id === change.id) ||
                !change.fields || typeof change.fields !== "object" || Array.isArray(change.fields) ||
                !Object.keys(change.fields).length || Object.entries(change.fields).some(([key, value]) => !allowed.has(key) || typeof value !== "boolean")) return true;
            seen.add(change.id);
            return false;
          })) {
        resync();
        return;
      }
      const changes = new Map(event.changes.map(change => [change.id, change.fields]));
      state = { ...state, channels: state.channels.map(channel => changes.has(channel.id) ? { ...channel, ...changes.get(channel.id) } : channel) };
      revision = event.revision;
    } else if (event.type === "channel" && event.revision === revision + 1) {
      if (!Array.isArray(state.channels) || !state.channels.some(channel => channel.id === event.id) ||
          typeof event.field !== "string" || !event.field || event.field === "id" ||
          (event.graphField !== undefined && (typeof event.graphField !== "string" || !event.graphField || event.graphField === "id"))) {
        resync();
        return;
      }
      if (event.displayColor !== undefined && (event.graphField !== "color" ||
          typeof event.displayColor !== "string" || !/^#[0-9a-f]{6}$/i.test(event.displayColor))) { resync(); return; }
      const channels = state.channels.map(channel => {
        if (channel.id !== event.id) return channel;
        const next = { ...channel, [event.field]: event.value };
        if (event.displayColor !== undefined) next.displayColor = event.displayColor;
        else if (event.graphField === "color" || event.field === "color") delete next.displayColor;
        return next;
      });
      let graph = state.graph;
      if (event.graphField && Array.isArray(graph?.chains)) {
        graph = { ...graph, chains: graph.chains.map(channel => channel.id === event.id ? { ...channel, [event.graphField]: event.value } : channel) };
      }
      let next = { ...state, channels, ...(graph ? { graph } : {}) };
      if (["chain_uuid", "source_uuid"].some(key => event.field === key || event.graphField === key) && !validStructure(next)) {
        resync();
        return;
      }
      if (event.field === "rack" || event.graphField === "rack") {
        if (!validStructure(next)) { resync(); return; }
        next = retainLivePrimary(next);
        if (!validPrimarySnapshot(next)) { resync(); return; }
      }
      state = next;
      revision = event.revision;
    } else if (event.type === "primary" && event.revision === revision + 1) {
      const parameter = event.parameter;
      const exists = Array.isArray(state.channels) && state.channels.some(channel => Array.isArray(channel.rack) && channel.rack.some(slot => slot.instance === event.instance));
      const valid = parameter === null || validPrimary(parameter);
      if (!Number.isSafeInteger(event.instance) || event.instance < 0 || !exists || !valid) { resync(); return; }
      const primary = { ...(state.primary ?? {}) };
      if (parameter === null) delete primary[event.instance];
      else primary[event.instance] = parameter;
      state = { ...state, primary };
      revision = event.revision;
    } else if (event.type === "structure" && event.revision === revision + 1) {
      if (!state.graph || !validStructure({ channels: event.channels, graph: { chains: event.chains } })) {
        resync();
        return;
      }
      state = retainLivePrimary({ ...state, channels: event.channels, graph: { ...state.graph, chains: event.chains } });
      revision = event.revision;
    } else if (event.type === "order" && event.revision === revision + 1) {
      const ids = event.ids;
      const channels = state.channels;
      if (!Array.isArray(ids) || !Array.isArray(channels) || ids.length !== channels.length ||
          new Set(ids).size !== ids.length || ids.some(id => !channels.some(channel => channel.id === id)) ||
          (state.graph && (!Array.isArray(state.graph.chains) || state.graph.chains.length !== ids.length ||
            ids.some(id => !state.graph.chains.some(channel => channel.id === id))))) {
        resync();
        return;
      }
      const reorder = list => ids.map(id => list.find(channel => channel.id === id));
      state = { ...state, channels: reorder(channels), ...(state.graph ? { graph: { ...state.graph, chains: reorder(state.graph.chains) } } : {}) };
      revision = event.revision;
    } else {
      resync();
      return;
    }
    // The bundled renderer treats state as read-only. Other consumers keep the
    // isolated copy by default, so they cannot mutate the authoritative mirror.
    render(borrowState ? state : structuredClone(state), event);
  }, subscription);
  return () => {
    disposed = true;
    unsubscribe();
  };
}

export async function toggleMute(host, channel) {
  return host.channel.setMute(channel.id, !channel.muted);
}
