import { copyMockChannel } from "./web/mock-copy-channel.mjs";
import { createI18nCache } from "./web/i18n-cache.mjs";
import { mockSendTargets } from "./web/mock-send-targets.mjs";
import { mockPerformance } from "./web/mock-performance.mjs";
import { applyLinkDraft, createLinkDraft, isRouteBridge, linkControls, linkedSlotRows, linkedSlotTargets, moveLinkedSlot, selectLinkGroup, setLinkControl } from "./web/mock-link-groups.mjs";

// Local contract fixture. No network, audio engine or production host is used.
export function createMockAudcore(initial = {}, options = {}) {
  // A standalone browser cannot distinguish OS DPI from browser zoom.
  let state = { display: { dpi: null, clientWidth: null, clientHeight: null }, transport: { playing: false }, audio: { running: true, sampleRate: 48000, bufferFrames: 128, latencyMs: 2.7, xruns: 0 }, sidechains: [], ...structuredClone(initial) };
  const themes = options.themes ?? ["dark", "light"];
  if (!Array.isArray(themes) || !themes.length || new Set(themes).size !== themes.length ||
      themes.some(theme => theme !== "dark" && theme !== "light")) throw new RangeError("invalid skin themes");
  const scaleRange = options.scale ?? { min: 0.75, max: 2, default: 1 };
  if (!scaleRange || ![scaleRange.min, scaleRange.max, scaleRange.default].every(Number.isFinite) ||
      scaleRange.min < 0.25 || scaleRange.max > 4 || scaleRange.min > scaleRange.default || scaleRange.default > scaleRange.max) throw new RangeError("invalid skin scale");
  let preferredTheme = state.appearance?.theme === "light" ? "light" : "dark";
  const effectiveTheme = theme => themes.includes(theme) ? theme : themes[0];
  const initialScale = state.appearance?.scale;
  state = { ...state, appearance: { ...state.appearance, scale: Number.isFinite(initialScale) && initialScale >= scaleRange.min && initialScale <= scaleRange.max ? initialScale : scaleRange.default, theme: effectiveTheme(preferredTheme) } };
  let revision = 0;
  let nextId = 1;
  let nextChannelIdentity = 1;
  const knownChannelIdentities = new Set((Array.isArray(state.graph?.chains) ? state.graph.chains : []).map(chain => chain.chain_uuid).filter(Boolean));
  let closed = false;
  const makeStorage = () => {
    const values = new Map();
    const check = key => { if (closed) throw new Error("bridge closed"); if (typeof key !== "string") throw new TypeError("invalid storage key"); };
    return Object.freeze({
      async get(key) { check(key); return values.has(key) ? structuredClone(values.get(key)) : null; },
      async set(key, value) { check(key); const encoded = JSON.stringify(value); if (encoded === undefined) throw new TypeError("invalid storage value"); values.set(key, JSON.parse(encoded)); },
      async remove(key) { check(key); values.delete(key); },
      async keys() { check(""); return [...values.keys()].sort(); },
      async clear() { check(""); values.clear(); }
    });
  };
  const documentStorage = makeStorage();
  const localStorage = makeStorage();
  let mockBounds = { x: 0, y: 0, width: 720, height: 480, dpi: 96, alwaysOnTop: false };
  const boundsListeners = new Set();
  let editing = false;
  const visibility = options.visibility;
  let sleeping = Boolean(visibility?.hidden);
  let visibilityEpoch = 0;
  const listeners = new Map();
  const meterListeners = new Set();
  let meterLoudness = false;
  const noticeListeners = new Set();
  const parameterListeners = new Set();
  const parameterUpdates = new Map();
  let effectParameters = false;
  const commands = [];
  const i18n = createI18nCache();

  function snapshot() {
    return { revision, state: structuredClone(state) };
  }

  function notifyParameters(updates) {
    if (closed || sleeping || !effectParameters || !updates.length) return;
    for (const listener of [...parameterListeners]) {
      if (parameterListeners.has(listener)) listener(structuredClone(updates));
    }
  }

  function notify(event) {
    if (closed) return;
    const appearance = event.type === "snapshot" ? event.state?.appearance
      : event.type === "change" && event.key === "appearance" ? event.value
      : event.type === "patch" ? event.changes?.appearance : null;
    if (appearance && typeof options.onAppearance === "function") options.onAppearance(appearance);
    if (sleeping) return;
    if (event.type === "snapshot") i18n.update(event.state?.i18n);
    else if (event.type === "change" && event.key === "i18n") i18n.update(event.value);
    else if (event.type === "patch" && event.changes?.i18n) i18n.update(event.changes.i18n);
    // A listener may unsubscribe while dispatch is in progress.
    for (const [id, listener] of [...listeners]) {
      if (listeners.has(id)) listener(structuredClone(event));
    }
    if (event.type === "snapshot") notifyParameters([...parameterUpdates.values()]);
  }

  // The mock host, not the skin, controls suspension and wake snapshots.
  function visibilityChanged() {
    const next = Boolean(visibility?.hidden);
    if (sleeping === next || closed) return;
    sleeping = next;
    visibilityEpoch += 1;
    if (sleeping) {
      editing = false;
      options.dismissInteractions?.();
    }
    if (!sleeping) {
      for (const listener of [...noticeListeners]) if (noticeListeners.has(listener)) listener({ level: "recording_expired" });
      if (listeners.size) notify({ type: "snapshot", ...snapshot() });
    }
  }
  visibility?.addEventListener("visibilitychange", visibilityChanged);

  function changeChannel(id, field, value) {
    if (closed) throw new Error("bridge closed");
    const channels = state.channels;
    if (!Array.isArray(channels)) throw new TypeError("channels unavailable");
    if (!channels.some(channel => channel.id === id)) throw new RangeError("channel not found");
    const updatedChannels = channels.map(channel => channel.id === id ? { ...channel, [field]: value } : channel);
    // Solo and recording are runtime state, not persistent graph fields.
    const graphField = { muted: "mute", gainDb: "gain_db", phase: "phase", fxBypass: "fx_bypass", rack: "rack", sends: "sends", name: "name", color: "color", icon: "icon", channel_mode: "channel_mode", ignore_latency: "ignore_latency", hidden: "hidden", align_right: "align_right", recording_group: "recording_group", recording_tap: "recording_tap" }[field];
    let updatedGraph = state.graph;
    if (graphField && Array.isArray(updatedGraph?.chains)) {
      updatedGraph = {
        ...state.graph,
        chains: state.graph.chains.map(channel => channel.id === id ? { ...channel, [graphField]: value } : channel)
      };
    }
    commands.push({ type: field, id, value });
    state = { ...state, channels: updatedChannels, ...(updatedGraph ? { graph: updatedGraph } : {}) };
    revision += 1;
    notify({ type: "channel", revision, id, field, value, ...(graphField ? { graphField } : {}) });
  }

  function changeEffect(id, instance, change) {
    if (closed) throw new Error("bridge closed");
    const channel = state.channels?.find(item => item.id === id);
    if (!channel) throw new RangeError("channel not found");
    if (!Array.isArray(channel.rack) || !channel.rack.some(effect => effect.instance === instance)) throw new RangeError("effect not found");
    const rack = channel.rack.flatMap(effect => effect.instance === instance ? change(effect) : [effect]);
    changeChannel(id, "rack", rack);
  }
  function sendKey(send) {
    const dest = send?.dest;
    return JSON.stringify([send?.id ?? null, dest?.kind, dest?.id, dest?.pair, dest?.endpoint, dest?.instance, send?.output_channel ?? null]);
  }
  function checkChannel(channel, identity) {
    if (!identity || typeof identity !== "object" || !("chain_uuid" in identity) || !("source_uuid" in identity)) throw new TypeError("invalid channel identity");
    if ((channel.chain_uuid ?? null) !== identity.chain_uuid || (channel.source_uuid ?? null) !== identity.source_uuid) throw new Error("channel identity changed");
  }
  function checkExpectedChannel(id, expected) {
    if (expected === undefined) return;
    const channel = state.channels?.find(item => item.id === id);
    if (!channel) throw new RangeError("channel not found");
    checkChannel(channel, expected);
  }
  function checkExpectedEffect(id, effect, expected) {
    if (expected === undefined) return;
    const channel = state.channels?.find(item => item.id === id);
    if (!channel || !expected || typeof expected !== "object") throw new TypeError("invalid effect identity");
    checkChannel(channel, expected.channel);
    for (const key of ["effect_uuid", "path", "fuid", "cid"]) {
      if (!(key in expected)) throw new TypeError("invalid effect identity");
      if ((effect[key] ?? (key === "path" ? "" : null)) !== expected[key]) throw new Error("effect identity changed");
    }
  }
  function checkExpectedTarget(id, effect, expected) {
    if (expected === undefined) return;
    if (!effect && expected === null) return;
    if (!effect || !expected || typeof expected !== "object" || expected.instance !== effect.instance) throw new Error("effect target changed");
    checkExpectedEffect(id, effect, expected);
  }
  function checkSend(send, expected, channel) {
    if (expected === undefined) return;
    if (!expected || typeof expected !== "object" || !expected.dest || typeof expected.dest !== "object") throw new TypeError("invalid send identity");
    if (expected.channel !== undefined) {
      checkChannel(channel, expected.channel);
    }
    if (sendKey(send) !== sendKey(expected)) throw new Error("send route changed");
  }
  function changeSend(id, index, change, expected) {
    if (closed) throw new Error("bridge closed");
    const channel = state.channels?.find(item => item.id === id);
    if (!channel || !Number.isInteger(index) || index < 0 || !Array.isArray(channel.sends) || index >= channel.sends.length) throw new RangeError("send not found");
    checkSend(channel.sends[index], expected, channel);
    changeChannel(id, "sends", channel.sends.flatMap((send, i) => i === index ? change(send) : [send]));
  }

  function publishStructure(channels, chains) {
    const live = new Set(channels.flatMap(channel => (channel.rack ?? []).map(effect => String(effect.instance))));
    const primary = Object.fromEntries(Object.entries(state.primary ?? {}).filter(([instance]) => live.has(instance)));
    const effectInfo = Object.fromEntries(Object.entries(state.effectInfo ?? {}).filter(([instance]) => live.has(instance)));
    const sidechains = (state.sidechains ?? []).filter(instance => live.has(String(instance)));
    const sidechainsChanged = sidechains.length !== (state.sidechains ?? []).length;
    state = { ...state, channels, graph: { ...state.graph, chains }, primary, effectInfo };
    revision += 1;
    notify({ type: "structure", revision, channels, chains });
    if (sidechainsChanged) {
      state = { ...state, sidechains };
      notify({ type: "change", revision: ++revision, key: "sidechains", value: sidechains });
    }
  }
  function publishLinkDraft(next) {
    const previous = state;
    state = { ...state, ...next };
    if (JSON.stringify(previous.graph.link_groups ?? {}) !== JSON.stringify(next.graph.link_groups ?? {})) {
      revision += 1;
      notify({ type: "graph_patch", revision, changes: { link_groups: next.graph.link_groups ?? {} } });
    }
    for (const channel of next.channels) {
      const before = previous.channels.find(item => item.id === channel.id);
      if (!before) throw new Error("channel identity changed");
      for (const [field, graphField] of [["mute_group", "mute_group"], ["muted", "mute"]]) {
        if ((before[field] ?? null) === (channel[field] ?? null)) continue;
        revision += 1;
        notify({ type: "channel", revision, id: channel.id, field, graphField, value: channel[field] ?? null });
      }
    }
  }

  function publishRuntime(batch) {
    if (!batch.length) return;
    const updates = new Map(batch.map(item => [item.id, item.fields]));
    state = { ...state, channels: state.channels.map(channel => updates.has(channel.id) ? { ...channel, ...updates.get(channel.id) } : channel) };
    revision += 1;
    notify({ type: "channel_batch", revision, changes: batch });
  }
  function linkGroup(value) {
    const group = typeof value === "string" ? value.trim().toUpperCase() : "";
    return /^[A-Z][0-9]+$/.test(group) ? group : null;
  }
  function existingLinks() {
    return [...new Set([...Object.keys(state.graph?.link_groups ?? {}), ...(state.graph?.chains ?? []).map(chain => chain.mute_group)].map(linkGroup).filter(Boolean))].sort();
  }
  function linkedChange(id, field, value) {
    if (closed) throw new Error("bridge closed");
    const chains = state.graph?.chains;
    if (!Array.isArray(chains)) { changeChannel(id, field, value); return; }
    const source = chains?.find(chain => chain.id === id);
    if (!source || !state.channels?.some(channel => channel.id === id)) throw new RangeError("channel not found");
    const group = linkGroup(source.mute_group);
    const option = { muted: "mute", gainDb: "gain", fxBypass: "fx", solo: "solo" }[field];
    const controls = chain => {
      const configured = state.graph.link_groups?.[linkGroup(chain.mute_group)] ?? {};
      return { mute: true, gain: false, fx: false, solo: false, ...configured };
    };
    const sourceControls = controls(source);
    const recGroup = typeof source.recording_group === "string" && /^[A-E]$/.test(source.recording_group) ? source.recording_group : null;
    const changes = new Map();
    for (const chain of chains) {
      const peerGroup = linkGroup(chain.mute_group);
      const same = group && group === peerGroup;
      const selected = chain.id === id || (field === "recording" ? recGroup && chain.recording_group === recGroup : option && sourceControls[option] && same);
      if (selected && (field !== "solo" || chain.id < 32)) changes.set(chain.id, value);
      else if (field === "muted" && !value && sourceControls.mute && controls(chain).mute && group && peerGroup && group[0] === peerGroup[0]) changes.set(chain.id, true);
    }
    if (field === "gainDb") {
      const members = chains.filter(chain => changes.has(chain.id));
      if (members.some(chain => !Number.isFinite(chain.gain_db ?? 0))) throw new RangeError("invalid gain");
      const lower = Math.max(...members.map(chain => Math.min(-60 - (chain.gain_db ?? 0), 0)));
      const upper = Math.min(...members.map(chain => Math.max((state.channelControls?.gainLimit ? 0 : 12) - (chain.gain_db ?? 0), 0)));
      const delta = Math.max(lower, Math.min(upper, value - (source.gain_db ?? 0)));
      for (const chain of members) changes.set(chain.id, (chain.gain_db ?? 0) + delta);
    }
    if (changes.size === 0) return;
    if (field === "solo" || field === "recording") {
      const batch = state.channels.filter(channel => changes.has(channel.id) && Boolean(channel[field]) !== changes.get(channel.id))
        .map(channel => ({ id: channel.id, fields: { [field]: changes.get(channel.id) } }));
      publishRuntime(batch);
      return;
    }
    if (changes.size === 1 && changes.has(id)) { changeChannel(id, field, changes.get(id)); return; }
    const graphField = { muted: "mute", gainDb: "gain_db", fxBypass: "fx_bypass" }[field];
    const nextChannels = state.channels.map(channel => changes.has(channel.id) ? { ...channel, [field]: changes.get(channel.id) } : channel);
    const nextChains = graphField ? chains.map(chain => changes.has(chain.id) ? { ...chain, [graphField]: changes.get(chain.id) } : chain) : chains;
    publishStructure(nextChannels, nextChains);
  }
  function validateAnchor(anchor) {
    if (!anchor || typeof anchor !== "object" || Array.isArray(anchor) ||
        (anchor.space !== undefined && anchor.space !== "client-css") ||
        !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || Math.abs(anchor.x) > 1000000 || Math.abs(anchor.y) > 1000000) {
      throw new RangeError("invalid menu position");
    }
  }
  async function showMenu(anchor, items) {
    if (closed) throw new Error("bridge closed");
    validateAnchor(anchor);
    if (typeof options.showMenu !== "function") throw new Error("当前模拟预览不支持原生菜单");
    if (sleeping) throw new Error("preview is sleeping");
    const epoch = visibilityEpoch;
    const choice = await options.showMenu({ anchor: { ...anchor }, items });
    if (closed) throw new Error("bridge closed");
    if (sleeping || epoch !== visibilityEpoch) return null;
    const contains = entries => entries.some(item => item.children ? contains(item.children) : !item.disabled && item.id === choice);
    if (choice != null && !contains(items)) throw new RangeError("invalid menu action");
    return choice;
  }

  function awakeApi(methods) {
    return Object.freeze(Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, (...args) => {
      if (closed) return Promise.reject(new Error("bridge closed"));
      if (sleeping) return Promise.reject(new Error("preview is sleeping"));
      return method(...args);
    }])));
  }

  function addChannel(mode, properties) {
    if (closed) throw new Error("bridge closed");
    if (mode !== null && mode !== 0 && mode !== 1) throw new RangeError("invalid channel mode");
    if (!Array.isArray(state.channels) || !Array.isArray(state.graph?.chains)) throw new Error("graph unavailable");
    const occupied = new Set(state.graph.chains.map(chain => chain.id));
    let id = Math.max(-1, ...occupied) + 1;
    if (!Number.isInteger(id)) throw new RangeError("invalid channel id");
    if (id >= 32) id = Array.from({ length: 32 }, (_, index) => index).find(index => !occupied.has(index));
    if (id === undefined) throw new RangeError("channel limit reached");
    let identity;
    do { identity = `mock-channel-${nextChannelIdentity++}`; } while (knownChannelIdentities.has(identity) || state.graph.chains.some(chain => chain.chain_uuid === identity));
    knownChannelIdentities.add(identity);
    const chain = { id, chain_uuid: identity, name: "", color: null, inputs: [], rack: [], sends: [], gain_db: 0, mute: false, channel_mode: mode, ...properties };
    publishStructure([...state.channels, { ...structuredClone(chain), muted: false, gainDb: 0, fxBypass: false }], [...state.graph.chains, chain]);
  }

  const api = {
    notifications: Object.freeze({
      subscribe(listener) {
        if (typeof listener !== "function") throw new TypeError("listener must be a function");
        if (closed) throw new Error("bridge closed");
        noticeListeners.add(listener);
        return () => noticeListeners.delete(listener);
      }
    }),
    i18n: Object.freeze({
      getLanguage: i18n.getLanguage,
      t: i18n.t,
      async setLanguage(language) {
        if (closed) throw new Error("bridge closed");
        if (sleeping) throw new Error("preview is sleeping");
        const messages = options.locales?.[language];
        if (!messages || typeof messages !== "object") throw new RangeError("language unavailable");
        api.fixture.update("i18n", { language, messages });
      }
    }),
    state: Object.freeze({
      async resync() {
        if (closed) throw new Error("bridge closed");
        if (listeners.size === 0) throw new Error("尚未订阅状态");
        if (sleeping) return { deferred: true };
        notify({ type: "snapshot", ...snapshot() });
      },
      async subscribe(listener, subscription) {
        if (closed) throw new Error("bridge closed");
        if (typeof listener !== "function") throw new TypeError("listener must be a function");
        if (listeners.size) throw new Error("only one state subscription is supported");
        const id = nextId++;
        effectParameters = subscription?.effectParameters === true;
        listeners.set(id, listener);
        try {
          if (!sleeping) {
            const initial = { type: "snapshot", ...snapshot() };
            i18n.update(initial.state.i18n);
            listener(initial);
            notifyParameters([...parameterUpdates.values()]);
          }
        } catch (error) {
          listeners.delete(id);
          effectParameters = false;
          throw error;
        }
        return () => { listeners.delete(id); effectParameters = false; i18n.clear(); };
      }
    }),
    transport: awakeApi({
      async setPlaying(playing) {
        if (typeof playing !== "boolean") throw new TypeError("invalid transport state");
        if (state.transport?.playing !== playing) api.fixture.update("transport", { playing });
      }
    }),
    recording: awakeApi({
      async revealSaved() { throw new Error("预览不包含真实录音文件"); }
    }),
    channel: awakeApi({
      async add(mode) {
        addChannel(mode, {});
      },
      async addNode(kind, index, binding) {
        if (!["input", "output"].includes(kind)) throw new RangeError("invalid node kind");
        const graph = state.graph;
        const offset = graph?.[kind + "_pairs"]?.[index];
        if (!Number.isInteger(index) || !Number.isInteger(offset)) throw new RangeError("device unavailable");
        const expected = [offset, graph[kind + "_devices"]?.[index] ?? null, graph.backend ?? null, graph[kind] ?? null];
        if (JSON.stringify(binding) !== JSON.stringify(expected)) throw new Error("device changed; retry");
        addChannel(null, kind === "input" ? { inputs: [index] } : {
          purpose: "node_output_bus",
          sends: [{ dest: { kind: "output", pair: index }, enabled: true, tap: 2, level_db: 0 }],
        });
      },
      async remove(id, expectedChannel) {
        if (closed) throw new Error("bridge closed");
        checkExpectedChannel(id, expectedChannel);
        const chains = state.graph?.chains;
        const source = chains?.find(chain => chain.id === id);
        if (!source || !state.channels?.some(channel => channel.id === id)) throw new RangeError("channel not found");
        const instances = new Set((source.rack ?? []).map(slot => slot.instance));
        const prune = item => Array.isArray(item.sends) ? { ...item, sends: item.sends.filter(send => !(send.dest?.kind === "chain" && send.dest.id === id) && !(send.dest?.kind === "sidechain" && instances.has(send.dest.instance))) } : item;
        publishStructure(state.channels.filter(channel => channel.id !== id).map(prune), chains.filter(chain => chain.id !== id).map(prune));
      },
      async setMute(id, muted, expectedChannel) {
        if (typeof muted !== "boolean") throw new TypeError("invalid mute");
        checkExpectedChannel(id, expectedChannel);
        linkedChange(id, "muted", muted);
      },
      async setSolo(id, solo, expectedChannel) {
        if (typeof solo !== "boolean") throw new TypeError("invalid solo");
        checkExpectedChannel(id, expectedChannel);
        linkedChange(id, "solo", solo);
      },
      async setSoloSafe(id, safe, expectedChannel) {
        if (closed) throw new Error("bridge closed");
        checkExpectedChannel(id, expectedChannel);
        if (typeof safe !== "boolean") throw new TypeError("invalid solo safe");
        const channel = state.channels?.find(item => item.id === id);
        if (!Number.isInteger(id) || id < 0 || id >= 32 || !channel) throw new RangeError("solo unavailable");
        if (Boolean(channel.solo_safe) !== safe) publishRuntime([{ id, fields: { solo_safe: safe } }]);
      },
      async setGain(id, db, expectedChannel) {
        if (!Number.isFinite(db) || db < -60 || db > 12) throw new RangeError("invalid gain");
        checkExpectedChannel(id, expectedChannel);
        linkedChange(id, "gainDb", db);
      },
      async setRecording(id, recording, expectedChannel) {
        if (typeof recording !== "boolean") throw new TypeError("invalid recording");
        checkExpectedChannel(id, expectedChannel);
        linkedChange(id, "recording", recording);
      },
      async setPhase(id, degrees, expectedChannel) {
        if (!Number.isFinite(degrees) || degrees < -180 || degrees > 180) throw new RangeError("invalid phase");
        checkExpectedChannel(id, expectedChannel);
        changeChannel(id, "phase", degrees);
      },
      async setFxBypass(id, bypass, expectedChannel) {
        if (typeof bypass !== "boolean") throw new TypeError("invalid bypass");
        checkExpectedChannel(id, expectedChannel);
        linkedChange(id, "fxBypass", bypass);
      },
      async setSendLevel(id, index, db, expected) {
        if (!Number.isInteger(index) || index < 0 || !Number.isFinite(db) || db < -60 || db > 6) throw new RangeError("invalid send level");
        const channel = state.channels?.find(item => item.id === id);
        if (!channel || !Array.isArray(channel.sends) || index >= channel.sends.length) throw new RangeError("send not found");
        const route = channel.sends[index];
        checkSend(route, expected, channel);
        const sends = structuredClone(channel.sends);
        const limited = Math.min(state.channelControls?.gainLimit ? 0 : 6, db);
        sends[index].level_db = Math.sign(limited) * Math.round(Math.abs(limited) * 10) / 10 || 0;
        changeChannel(id, "sends", sends);
      },
      async setSendEnabled(id, index, enabled, expected) {
        if (typeof enabled !== "boolean") throw new TypeError("invalid enabled state");
        changeSend(id, index, send => [{ ...send, enabled }], expected);
      },
      async setSendTap(id, index, tap, expected) {
        if (!Number.isInteger(tap) || tap < 0 || tap > 2) throw new RangeError("invalid tap");
        changeSend(id, index, send => [{ ...send, tap }], expected);
      },
      async removeSend(id, index, expected) { changeSend(id, index, () => [], expected); },
      async removeSends(routes) {
        if (!Array.isArray(routes) || !routes.length || routes.length > 32 * 256) throw new RangeError("invalid sends");
        const byChannel = new Map();
        for (const { id, index, expected } of routes) {
          const channel = state.channels?.find(item => item.id === id);
          if (!channel || !Number.isSafeInteger(index) || !channel.sends?.[index] || !expected?.channel) throw new RangeError("invalid send");
          checkSend(channel.sends[index], expected, channel);
          const indices = byChannel.get(id) ?? new Set();
          if (indices.has(index)) throw new RangeError("invalid sends");
          indices.add(index);
          byChannel.set(id, indices);
        }
        const update = channel => byChannel.has(channel.id) ? { ...channel,
          sends: channel.sends.filter((_, index) => !byChannel.get(channel.id).has(index)) } : channel;
        publishStructure(state.channels.map(update), state.graph.chains.map(update));
      },
      async moveSend(id, from, to, expected, expectedChannel) {
        const channel = state.channels?.find(channel => channel.id === id);
        const sends = channel?.sends;
        if (expectedChannel !== undefined && channel) checkChannel(channel, expectedChannel);
        if (!Array.isArray(sends) || JSON.stringify(sends) !== JSON.stringify(expected)) throw new Error("sends changed; retry");
        if (![from, to].every(index => Number.isInteger(index) && index >= 0 && index < sends.length)) throw new RangeError("invalid send");
        if (from === to) return;
        const reordered = structuredClone(sends);
        reordered.splice(to, 0, reordered.splice(from, 1)[0]);
        changeChannel(id, "sends", reordered);
      },
      async addSend(id, targetId, expectedChannel) {
        if (closed) throw new Error("bridge closed");
        checkExpectedChannel(id, expectedChannel);
        const channel = state.channels?.find(item => item.id === id);
        const target = mockSendTargets(state.graph, id, i18n.t, state.sidechains).find(item => item.id === targetId);
        if (!channel || !Array.isArray(channel.sends) || !target) throw new RangeError("send target unavailable");
        changeChannel(id, "sends", [...channel.sends, { dest: target.dest, ...(target.output_channel == null ? {} : { output_channel:target.output_channel }), enabled: true, level_db: 0, tap: 2 }]);
      },
      async setName(id, name, expectedChannel) {
        if (typeof name !== "string" || name.length > 1024) throw new TypeError("invalid channel name");
        checkExpectedChannel(id, expectedChannel);
        changeChannel(id, "name", name);
      },
      async setHidden(id, hidden, expectedChannel) {
        if (typeof hidden !== "boolean") throw new TypeError("invalid hidden state");
        checkExpectedChannel(id, expectedChannel);
        changeChannel(id, "hidden", hidden);
      },
      async setInput(id, index, expectedChannel) {
        if (closed) throw new Error("bridge closed");
        checkExpectedChannel(id, expectedChannel);
        const chains = state.graph?.chains;
        const pairs = state.graph?.input_pairs;
        if (!Array.isArray(chains) || !Array.isArray(pairs) || !state.channels?.some(channel => channel.id === id) || !chains.some(chain => chain.id === id)) throw new RangeError("channel unavailable");
        if (index !== null && (!Number.isInteger(index) || index < 0 || index >= pairs.length)) throw new RangeError("input unavailable");
        const update = channel => channel.id !== id ? channel : {
          ...channel,
          inputs: index === null ? [] : [index],
          virtual_input: null,
          rack: (channel.rack ?? []).filter(slot => !slot.alias?.startsWith("@wdm-play-"))
        };
        publishStructure(state.channels.map(update), chains.map(update));
      },
      async showHidden() {
        if (closed) throw new Error("bridge closed");
        if (!Array.isArray(state.channels) || !Array.isArray(state.graph?.chains)) throw new Error("graph unavailable");
        const ids = new Set(state.graph.chains.filter(chain => chain.hidden && !(chain.rack ?? []).some(effect => effect.alias?.startsWith("@wdm-rec-"))).map(chain => chain.id));
        if (!ids.size) return;
        const show = item => ids.has(item.id) ? { ...item, hidden: false } : item;
        publishStructure(state.channels.map(show), state.graph.chains.map(show));
      },
      async setAlignRight(id, right, expectedChannel) {
        if (typeof right !== "boolean") throw new TypeError("invalid alignment");
        checkExpectedChannel(id, expectedChannel);
        changeChannel(id, "align_right", right);
      },
      async setOrder(ids, expected) {
        if (closed) throw new Error("bridge closed");
        const channels = state.channels;
        if (!Array.isArray(ids) || !Array.isArray(channels) || ids.length !== channels.length ||
            ids.some(id => !Number.isInteger(id) || id < 0 || id >= 32) ||
            new Set(ids).size !== ids.length || ids.some(id => !channels.some(channel => channel.id === id))) throw new RangeError("invalid channel order");
        const guard = channels.map(channel => [channel.id, { chain_uuid:channel.chain_uuid ?? null, source_uuid:channel.source_uuid ?? null }, Boolean(channel.hidden), Boolean(channel.align_right)]);
        if (expected !== undefined && JSON.stringify(expected) !== JSON.stringify(guard)) throw new Error("channel order changed; retry");
        const reorder = list => ids.map(id => list.find(channel => channel.id === id));
        const graph = state.graph;
        if (graph && (!Array.isArray(graph.chains) || graph.chains.length !== ids.length || ids.some(id => !graph.chains.some(channel => channel.id === id)))) {
          throw new RangeError("graph channel mismatch");
        }
        state = { ...state, channels: reorder(channels), ...(graph ? { graph: { ...graph, chains: reorder(graph.chains) } } : {}) };
        revision += 1;
        notify({ type: "order", revision, ids: [...ids] });
      }
    }),
    appearance: awakeApi({
      async setTheme(theme) {
        if (closed) throw new Error("bridge closed");
        if (!themes.includes(theme)) throw new RangeError("invalid theme");
        if (state.appearance?.theme === theme) return;
        api.fixture.update("appearance", { ...state.appearance, theme });
      },
      async setScale(scale) {
        if (closed) throw new Error("bridge closed");
        if (!Number.isFinite(scale) || scale < scaleRange.min || scale > scaleRange.max) throw new RangeError("invalid scale");
        if (state.appearance?.scale === scale) return;
        api.fixture.update("appearance", { ...(state.appearance ?? { theme: "dark" }), scale });
      }
    }),
    audio: awakeApi({
      async dropFile(file,id,expectedChannel) {
        if (!file || typeof file.name!=="string" || !/\.(?:caf|wav|flac|opus)$/i.test(file.name)) throw new Error("invalid dropped file");
        const original=id===null ? null : state.graph?.chains?.find(item=>item.id===id);
        if(id!==null) {
          if(!original)throw new Error("channel not found");
          checkExpectedChannel(id,expectedChannel);
          const expected=JSON.stringify(original);
          const input=(original.inputs ?? []).some(index=>state.graph.input_devices?.[index]?.backend!=="file") || original.virtual_input || (original.rack ?? []).some(item=>item.alias?.startsWith("@wdm-play-"));
          if(input) {
            if(typeof options.confirmAudioDrop!=="function")throw new Error("preview confirmation unavailable");
            const epoch=visibilityEpoch;
            if(!await options.confirmAudioDrop(i18n.t))return null;
            if(closed || sleeping || epoch!==visibilityEpoch || JSON.stringify(state.graph?.chains?.find(item=>item.id===id))!==expected)throw new Error("channel input changed");
          }
        } else {
          const before=new Set(state.graph.chains.map(item=>item.id));
          await api.channel.add(null);
          id=state.graph.chains.find(item=>!before.has(item.id)).id;
        }
        const pairs=[...(state.graph.input_pairs ?? []),0], index=pairs.length-1;
        const input_devices={...(state.graph.input_devices ?? {}),[index]:{backend:"file",name:`mock://${file.name}`}};
        const update=item=>item.id===id ? {...item,inputs:[index],virtual_input:null,rack:(item.rack ?? []).filter(effect=>!effect.alias?.startsWith("@wdm-play-"))} : item;
        state={...state,channels:state.channels.map(update),graph:{...state.graph,chains:state.graph.chains.map(update),input_pairs:pairs,input_devices}};
        revision++;notify({type:"snapshot",...snapshot()});
        return {chain:id};
      }
    }),
    effect: Object.freeze({ ...awakeApi({
      async openBrowser(id, expectedChannel) {
        checkExpectedChannel(id, expectedChannel);
        if (closed) throw new Error("bridge closed");
        if (!state.channels?.some(channel => channel.id === id)) throw new RangeError("channel not found");
        if (typeof options.selectEffect !== "function") throw new Error("当前模拟预览不支持效果器选择");
        const catalog = Array.isArray(options.catalog?.entries) ? options.catalog.entries : [];
        if (sleeping) throw new Error("preview is sleeping");
        const epoch = visibilityEpoch;
        const selected = await options.selectEffect(catalog, i18n.t);
        if (sleeping || epoch !== visibilityEpoch || selected == null) return;
        if (closed) throw new Error("bridge closed");
        const entry = catalog.find(item => item.id === selected);
        const channel = state.channels?.find(item => item.id === id);
        if (!entry || !channel || !Array.isArray(channel.rack)) throw new RangeError("effect or channel unavailable");
        const next = (state.channels ?? []).reduce((max, item) => (item.rack ?? []).reduce((value, slot) => Math.max(value, slot.instance), max), 0) + 1;
        if (!Number.isSafeInteger(next)) throw new RangeError("effect identity exhausted");
        // An offline marker makes it explicit that no VST has been loaded.
        changeChannel(id, "rack", [...channel.rack, { instance: next, path: `mock://${entry.id}`, alias: entry.name, offline: true }]);
      },
      async openEditor(id, instance, expected) {
        if (closed) throw new Error("bridge closed");
        const effect = state.channels?.find(channel => channel.id === id)?.rack?.find(effect => effect.instance === instance && !isRouteBridge(effect));
        if (!effect) throw new RangeError("effect not found");
        checkExpectedEffect(id, effect, expected);
        if (effect.offline || state.missingEffects?.[instance]) throw new RangeError("effect unavailable");
        throw new Error(i18n.t("skin.editor_unavailable"));
      },
      async move(id, instance, index, expected, expectedTarget) {
        if (closed) throw new Error("bridge closed");
        const channel = state.channels?.find(item => item.id === id);
        if (!channel || !Array.isArray(channel.rack)) throw new RangeError("channel not found");
        if (!Number.isInteger(index) || index < 0 || index > channel.rack.length) throw new RangeError("invalid effect position");
        const original = channel.rack.findIndex(item => item.instance === instance);
        if (original < 0 || isRouteBridge(channel.rack[original])) throw new RangeError("effect not found");
        checkExpectedEffect(id, channel.rack[original], expected);
        checkExpectedTarget(id, channel.rack[index], expectedTarget);
        if (index < channel.rack.length && isRouteBridge(channel.rack[index])) throw new RangeError("invalid effect position");
        const group = linkGroup(state.graph?.chains?.find(item => item.id === id)?.mute_group);
        if (group && state.graph.link_groups?.[group]?.slots) {
          const rows = linkedSlotRows(state.graph, id);
          const target = index === channel.rack.length ? rows.length - 1 : rows.findIndex(item => item?.instance === channel.rack[index].instance);
          if (target < 0) throw new RangeError("invalid effect position");
          return api.effect.moveSlot(id, instance, target, expected);
        }
        const rack = [...channel.rack];
        const [effect] = rack.splice(original, 1);
        rack.splice(Math.min(index, rack.length), 0, effect);
        changeChannel(id, "rack", rack);
      },
      async copyTo(id, instance, target, index, expectedEffect, expectedChannel, expectedRack) {
        if (closed) throw new Error("bridge closed");
        const source = state.channels?.find(channel => channel.id === id);
        const destination = state.channels?.find(channel => channel.id === target);
        const effect = source?.rack?.find(item => item.instance === instance && !isRouteBridge(item));
        if (!effect || !destination || id === target) throw new RangeError("effect or channel unavailable");
        checkExpectedEffect(id, effect, expectedEffect);
        checkExpectedChannel(target, expectedChannel);
        if (!Array.isArray(expectedRack) || JSON.stringify(destination.rack) !== JSON.stringify(expectedRack) || !Number.isInteger(index) || index < 0 || index > destination.rack.length) throw new RangeError("target rack changed");
        const next = state.channels.reduce((max, channel) => (channel.rack ?? []).reduce((value, item) => Math.max(value, item.instance), max), 0) + 1;
        if (!Number.isSafeInteger(next)) throw new RangeError("effect identity exhausted");
        const copy = { ...structuredClone(effect), instance:next, effect_uuid:`mock-effect-${next}`, bypass_shortcut:null };
        const rack = [...destination.rack];
        rack.splice(index, 0, copy);
        changeChannel(target, "rack", rack);
      },
      async insertDroppedFile(file, id, index, expectedChannel, expectedRack) {
        if (closed) throw new Error("bridge closed");
        if (!file || typeof file.name !== "string" || !/\.(?:vst3|fx\.audcore)$/i.test(file.name)) throw new Error("invalid dropped file");
        const channel=state.channels?.find(item=>item.id===id);
        checkExpectedChannel(id,expectedChannel);
        if (!channel || !Array.isArray(expectedRack) || JSON.stringify(channel.rack)!==JSON.stringify(expectedRack) || !Number.isInteger(index) || index<0 || index>channel.rack.length) throw new RangeError("target rack changed");
        const next=state.channels.reduce((max,item)=>(item.rack ?? []).reduce((value,slot)=>Math.max(value,slot.instance),max),0)+1;
        if (!Number.isSafeInteger(next)) throw new RangeError("effect identity exhausted");
        const rack=[...channel.rack];
        // Website preview never loads the selected native module.
        rack.splice(index,0,{instance:next,path:`mock://${file.name}`,alias:file.name,offline:true});
        changeChannel(id,"rack",rack);
      },
      async moveSlot(id, instance, index, expected, expectedTarget) {
        if (closed) throw new Error("bridge closed");
        const effect = state.channels?.find(channel => channel.id === id)?.rack?.find(item => item.instance === instance && !isRouteBridge(item));
        if (!effect) throw new RangeError("effect not found");
        checkExpectedEffect(id, effect, expected);
        const slots = linkedSlotRows(state.graph, id);
        if (!Number.isInteger(index) || index < 0 || index >= slots.length) throw new RangeError("invalid effect position");
        checkExpectedTarget(id, slots[index], expectedTarget);
        const graph = moveLinkedSlot(state.graph, id, instance, index);
        if (graph === state.graph) return;
        const updated = graph.chains.find(chain => chain.id === id);
        const previous = state.channels.find(channel => channel.id === id);
        const channels = state.channels.map(channel => channel.id === id ? { ...channel, rack: updated.rack } : channel);
        state = { ...state, graph, channels };
        revision += 1;
        notify({ type: "graph_patch", revision, changes: { link_slots: graph.link_slots } });
        if (JSON.stringify(previous.rack) !== JSON.stringify(updated.rack)) {
          revision += 1;
          notify({ type: "channel", revision, id, field: "rack", graphField: "rack", value: updated.rack });
        }
      },
      async setBypass(id, instance, bypass, expected) {
        if (typeof bypass !== "boolean") throw new TypeError("invalid bypass");
        const source = state.channels?.find(item => item.id === id);
        if (!source?.rack?.some(item => item.instance === instance && !isRouteBridge(item))) throw new RangeError("effect not found");
        checkExpectedEffect(id, source.rack.find(item => item.instance === instance), expected);
        const targets = linkedSlotTargets(state.graph, id, instance);
        if (targets.length <= 1) { changeEffect(id, instance, effect => [{ ...effect, bypass }]); return; }
        const changed = new Set(targets.filter(target => {
          const channel = state.channels.find(item => item.id === target.id);
          return channel?.rack.some(effect => effect.instance === target.instance && Boolean(effect.bypass) !== bypass);
        }).map(target => target.id));
        if (!changed.size) return;
        const update = chain => {
          const target = targets.find(item => item.id === chain.id && changed.has(item.id));
          return target ? { ...chain, rack: chain.rack.map(effect => effect.instance === target.instance ? { ...effect, bypass } : effect) } : chain;
        };
        const channels = state.channels.map(update);
        state = { ...state, channels, graph: { ...state.graph, chains: state.graph.chains.map(update) } };
        revision += 1;
        notify({ type: "effect_batch", revision, changes: channels.filter(channel => changed.has(channel.id)).map(({ id, rack }) => ({ id, rack })) });
      },
      async setWet(id, instance, wet, expected) {
        if (!Number.isFinite(wet) || wet < 0 || wet > 1) throw new RangeError("invalid wet");
        const effect = state.channels?.find(channel => channel.id === id)?.rack?.find(effect => effect.instance === instance && !isRouteBridge(effect));
        if (!effect) throw new RangeError("effect not found");
        checkExpectedEffect(id, effect, expected);
        if (effect.offline || state.missingEffects?.[instance]) throw new RangeError("effect unavailable");
        changeEffect(id, instance, effect => [{ ...effect, wet }]);
      },
      async setPrimary(id, instance, parameter, normalized, expected) {
        if (closed) throw new Error("bridge closed");
        const effect = state.channels?.find(channel => channel.id === id)?.rack?.find(item => item.instance === instance);
        const current = state.primary?.[instance];
        if (!effect || effect.offline || state.missingEffects?.[instance] || isRouteBridge(effect) || !current || current.id !== parameter || !Number.isFinite(normalized) || normalized < 0 || normalized > 1) throw new RangeError("primary unavailable");
        checkExpectedEffect(id, effect, expected);
        if (current.normalized === normalized) return;
        const next = { ...current, normalized };
        state = { ...state, primary: { ...state.primary, [instance]: next } };
        notify({ type: "primary", revision: ++revision, instance, parameter: next });
      },
      async resetPrimary(id, instance, parameter, expected) {
        const current = state.primary?.[instance];
        if (!current || current.id !== parameter) throw new RangeError("primary unavailable");
        return api.effect.setPrimary(id, instance, parameter, current.default_normalized, expected);
      },
      async remove(id, instance, expected) {
        if (closed) throw new Error("bridge closed");
        const channel = state.channels?.find(item => item.id === id);
        const chain = state.graph?.chains?.find(item => item.id === id);
        if (!channel?.rack?.some(item => item.instance === instance && !isRouteBridge(item)) || !chain?.rack?.some(item => item.instance === instance && !isRouteBridge(item))) throw new RangeError("effect not found");
        checkExpectedEffect(id, channel.rack.find(item => item.instance === instance), expected);
        const prune = item => ({
          ...item,
          ...(item.id === id ? { rack: item.rack.filter(effect => effect.instance !== instance) } : {}),
          ...(Array.isArray(item.sends) ? { sends: item.sends.filter(send => !(send.dest?.kind === "sidechain" && send.dest.instance === instance)) } : {})
        });
        publishStructure(state.channels.map(prune), state.graph.chains.map(prune));
      }
    }),
      onParameters(listener) {
        if (typeof listener !== "function") throw new TypeError("listener must be a function");
        if (closed) throw new Error("bridge closed");
        parameterListeners.add(listener);
        return () => parameterListeners.delete(listener);
      }
    }),
    meters: Object.freeze({
      async setLoudness(enabled) {
        if (closed) throw new Error("bridge closed");
        if (typeof enabled !== "boolean") throw new TypeError("invalid loudness subscription");
        if (!meterListeners.size || sleeping) throw new Error("meter subscription inactive");
        meterLoudness = enabled;
      },
      async subscribe(listener, options = {}) {
        if (closed) throw new Error("bridge closed");
        if (typeof listener !== "function") throw new TypeError("listener must be a function");
        if (meterListeners.size) throw new Error("only one meter subscription is supported");
        if (!options || typeof options !== "object" || Array.isArray(options) || (options.loudness !== undefined && typeof options.loudness !== "boolean")) throw new TypeError("invalid meter options");
        meterLoudness = options.loudness === true;
        meterListeners.add(listener);
        return () => { meterListeners.delete(listener); meterLoudness = false; };
      }
    }),
    history: Object.freeze({
      async beginEdit() {
        if (closed) throw new Error("bridge closed");
        if (sleeping) throw new Error("preview is sleeping");
        if (editing) throw new Error("edit already active");
        editing = true;
      },
      async endEdit() { if (closed) throw new Error("bridge closed"); editing = false; },
      async undo() { throw new Error("预览不支持撤销"); },
      async redo() { throw new Error("预览不支持重做"); }
    }),
    local: Object.freeze({ storage: localStorage }),
    document: Object.freeze({
      storage: documentStorage,
      async new() { throw new Error("预览不支持新建预设"); },
      async open() { throw new Error("预览不支持打开文件"); },
      async save() { throw new Error("预览不支持保存预设"); }
    }),
    settings: awakeApi({
      async open() {
        if (closed) throw new Error("bridge closed");
        if (typeof options.showSettings !== "function") throw new Error("当前模拟预览不支持设置窗口");
        if (sleeping) throw new Error("preview is sleeping");
        const epoch = visibilityEpoch;
        const guarded = action => (...args) => {
          if (closed || sleeping || epoch !== visibilityEpoch) throw new Error("preview is sleeping");
          return action(...args);
        };
        const setPreference = async theme => {
          if (theme !== "dark" && theme !== "light") throw new RangeError("invalid theme");
          preferredTheme = theme;
          const effective = effectiveTheme(theme);
          if (state.appearance.theme !== effective) api.fixture.update("appearance", { ...state.appearance, theme: effective });
          return effective;
        };
        await options.showSettings({ appearance: structuredClone(state.appearance), scaleRange: { ...scaleRange }, language: state.i18n?.language }, {
          setTheme: guarded(setPreference),
          setScale: guarded(api.appearance.setScale),
          setLanguage: guarded(api.i18n.setLanguage)
        }, i18n.t);
      }
    }),
    window: Object.freeze({ ...awakeApi({
      showUnderCover() {},
      presentFrame() {},
      startupFailed() {},
      async getBounds() { return { ...mockBounds }; },
      async getDisplays() { return [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, dpi: 96, primary: true }]; },
      async setAlwaysOnTop(enabled) { if (typeof enabled !== "boolean") throw new TypeError("invalid topmost state"); mockBounds = { ...mockBounds, alwaysOnTop: enabled }; for (const listener of [...boundsListeners]) if (boundsListeners.has(listener)) listener({ ...mockBounds }); },
      async setBounds(bounds) {
        if (!bounds || typeof bounds !== "object" || Array.isArray(bounds) || !Object.keys(bounds).length || Object.keys(bounds).some(key => !["x", "y", "width", "height"].includes(key))) throw new TypeError("invalid bounds");
        for (const [key, value] of Object.entries(bounds)) {
          if (!Number.isFinite(value) || (["x", "y"].includes(key) ? !Number.isInteger(value) || Math.abs(value) >= 100000 : value <= 0 || value > 10000)) throw new RangeError("invalid bounds");
        }
        mockBounds = { ...mockBounds, ...bounds };
        for (const listener of [...boundsListeners]) if (boundsListeners.has(listener)) listener({ ...mockBounds });
      },
      async subscribeBounds(listener) {
        if (typeof listener !== "function" || boundsListeners.size) throw new TypeError("invalid bounds listener");
        boundsListeners.add(listener);
        listener({ ...mockBounds });
        return () => boundsListeners.delete(listener);
      },
      async minimize() { throw new Error(closed ? "bridge closed" : "浏览器预览不支持窗体操作"); },
      async toggleMaximize() { throw new Error(closed ? "bridge closed" : "浏览器预览不支持窗体操作"); },
      async close() { throw new Error(closed ? "bridge closed" : "浏览器预览不支持窗体操作"); },
      async startDrag() { throw new Error(closed ? "bridge closed" : "浏览器预览不支持窗体操作"); },
      async startResize() { throw new Error(closed ? "bridge closed" : "浏览器预览不支持窗体操作"); }
    }), requiresStartup: () => false }),
    performance: awakeApi({
      async open() {
        if (closed) throw new Error("bridge closed");
        if (typeof options.showPerformance !== "function") throw new Error("当前模拟预览不支持性能面板");
        if (sleeping) throw new Error("preview is sleeping");
        await options.showPerformance(mockPerformance(state.graph), i18n.t);
      }
    }),
    menu: awakeApi({
      async openTransport(anchor) {
        const choice = await showMenu(anchor, [
          { id: "stop", label: i18n.t("停止") },
          { id: "restart", label: i18n.t("重新播放") }
        ]);
        if (choice !== null) await api.transport.setPlaying(choice === "restart");
      },
      async openSystem(anchor) {
        const choice = await showMenu(anchor, [
          { id: "new", label: i18n.t("新建预设"), children: [
            { id: "new-empty", label: i18n.t("新建空白预设") },
            { id: "new-monitor", label: i18n.t("新建单通道监听预设"), disabled: true },
            { id: "new-singing", label: i18n.t("新建简单唱歌直播预设"), disabled: true },
            { id: "new-chat", label: i18n.t("新建聊天和唱歌直播预设"), disabled: true }
          ] },
          { id: "open", label: i18n.t("打开文件"), disabled: true },
          { id: "save", label: i18n.t("保存预设"), disabled: true },
          { id: "settings", label: i18n.t("设置") },
          { id: "performance", label: i18n.t("性能") }
        ]);
        if (choice === "settings") await api.settings.open();
        else if (choice === "performance") await api.performance.open();
        else if (choice === "new-empty") {
          state = { ...state, graph: { ...state.graph, chains: [] }, channels: [], primary: {}, effectInfo: {}, sidechains: [] };
          revision += 1;
          notify({ type: "snapshot", ...snapshot() });
        }
      },
      async openSolo(id, anchor, expectedChannel) {
        checkExpectedChannel(id, expectedChannel);
        const channel = state.channels?.find(item => item.id === id);
        if (!channel || id >= 32) throw new RangeError("channel not found");
        const items = [
          { id: "toggle", label: i18n.t(channel.solo ? "取消独奏" : "独奏"), checked: !!channel.solo },
          { id: "exclusive", label: i18n.t("独占独奏") },
          { id: "clear", label: i18n.t("解除所有独奏") },
          { id: "safe", label: i18n.t("常驻"), checked: !!channel.solo_safe }
        ];
        const choice = await showMenu(anchor, items);
        if (choice == null) return;
        const current = state.channels?.find(item => item.id === id);
        if (!current) throw new RangeError("channel not found");
        if (choice === "toggle") { await api.channel.setSolo(id, !current.solo); return; }
        if (choice === "safe") { await api.channel.setSoloSafe(id, !current.solo_safe); return; }
        const source = state.graph?.chains?.find(item => item.id === id);
        if (!source) throw new RangeError("channel not found");
        const group = linkGroup(source.mute_group);
        const linked = group && (state.graph.link_groups?.[group]?.solo ?? false);
        const targets = new Set(state.graph.chains.filter(item => item.id < 32 && (item.id === id || (linked && linkGroup(item.mute_group) === group))).map(item => item.id));
        const batch = state.channels.flatMap(item => {
          const next = choice === "exclusive" && targets.has(item.id);
          return Boolean(item.solo) === next ? [] : [{ id: item.id, fields: { solo: next } }];
        });
        publishRuntime(batch);
      },
      async openLinkSettings(id, anchor, expectedChannel) {
        checkExpectedChannel(id, expectedChannel);
        const draft = createLinkDraft(state.graph, id);
        for (;;) {
          const current = draft.group ?? "";
          const letter = current[0] ?? "A";
          const number = current.slice(1) || "1";
          const controls = linkControls(draft);
          const choices = [
            { id: "letters", label: `${i18n.t("链接分组")} ${current ? letter : "—"}`, children: [..."ABCDE"].map(value => ({ id: `letter:${value}`, label: value, checked: value === letter && !!current })) },
            { id: "numbers", label: `${i18n.t("链接分组")} ${current ? number : "—"}`, children: [..."12345"].map(value => ({ id: `number:${value}`, label: value, checked: value === number && !!current })) },
            ...[["mute", "开关"], ["gain", "音量"], ["fx", "效果"], ["slots", "插槽"], ["solo", "独奏"]].map(([key, label]) => ({ id: `control:${key}`, label: i18n.t(label), checked: controls[key], disabled: !current })),
            { id: "apply", label: i18n.t("确定") },
            { id: "clear", label: i18n.t("清空链接") }
          ];
          const choice = await showMenu(anchor, choices);
          if (choice == null) return;
          if (choice === "apply" || choice === "clear") {
            if (choice === "clear") selectLinkGroup(draft, "");
            const next = applyLinkDraft(state.graph, state.channels, draft);
            publishLinkDraft(next);
            return;
          }
          if (choice.startsWith("letter:")) selectLinkGroup(draft, choice.slice(7) + number);
          else if (choice.startsWith("number:")) selectLinkGroup(draft, letter + choice.slice(7));
          else if (choice.startsWith("control:")) {
            const key = choice.slice(8);
            setLinkControl(draft, key, !controls[key]);
          }
        }
      },
      async openLink(id, anchor, expectedChannel) {
        checkExpectedChannel(id, expectedChannel);
        const channel = state.channels?.find(item => item.id === id);
        if (!channel) throw new RangeError("channel not found");
        const groups = existingLinks();
        const children = groups.length ? groups.map(group => ({ id: `group:${group}`, label: group })) : [{ id: "empty", label: i18n.t("暂无分组"), disabled: true }];
        const items = [{ id: "groups", label: i18n.t("链接分组"), children }];
        if (linkGroup(channel.mute_group)) items.push({ id: "clear", label: i18n.t("清空分组") });
        const choice = await showMenu(anchor, items);
        if (choice == null) return;
        const group = choice === "clear" ? null : linkGroup(choice.slice(6));
        if (choice !== "clear" && (!group || !existingLinks().includes(group))) throw new RangeError("link group unavailable");
        const draft = createLinkDraft(state.graph, id);
        selectLinkGroup(draft, group ?? "");
        const next = applyLinkDraft(state.graph, state.channels, draft);
        publishLinkDraft(next);
      },
      async openRecording(id, anchor, expectedChannel) {
        checkExpectedChannel(id, expectedChannel);
        const channel = state.channels?.find(item => item.id === id);
        if (!channel) throw new RangeError("channel not found");
        const taps = ["效果前", "效果后", "推子后"].map((label, tap) => ({
          id: `tap:${tap}`, label: i18n.t(label), checked: tap === (channel.recording_tap ?? 2)
        }));
        const items = [
          { id: "taps", label: i18n.t("录制时机"), children: taps },
          { id: "groups", label: i18n.t("录音分组"), children: [..."ABCDE"].map(group => ({ id: `group:${group}`, label: group })) }
        ];
        if (channel.recording_group) items.push({ id: "clear", label: i18n.t("清空分组") });
        const choice = await showMenu(anchor, items);
        if (choice?.startsWith("tap:")) changeChannel(id, "recording_tap", Number(choice.slice(4)));
        else if (choice != null) changeChannel(id, "recording_group", choice === "clear" ? null : choice.slice(6));
      },
      async openAddSend(id, anchor, expectedChannel) {
        checkExpectedChannel(id, expectedChannel);
        const targets = mockSendTargets(state.graph, id, i18n.t, state.sidechains);
        if (!state.channels?.some(channel => channel.id === id)) throw new RangeError("channel not found");
        if (!targets.length) throw new RangeError("send target unavailable");
        const choice = await showMenu(anchor, targets);
        if (choice != null) await api.channel.addSend(id, choice);
      },
      async openSend(id, index, anchor, expected) {
        const channel = state.channels?.find(item => item.id === id);
        const send = channel?.sends?.[index];
        if (!send || !Number.isInteger(index) || index < 0) throw new RangeError("send not found");
        checkSend(send, expected, channel);
        const identity = send.id == null ? JSON.stringify(send) : sendKey(send);
        const channelIdentity = JSON.stringify([channel.chain_uuid ?? null, channel.source_uuid ?? null]);
        const choice = await showMenu(anchor, [
          { id: "enabled", label: i18n.t(send.enabled === false ? "启用此路由" : "停用此路由") },
          { id: "tap:0", label: i18n.t("效果前"), checked: send.tap === 0 },
          { id: "tap:1", label: i18n.t("效果后推子前"), checked: send.tap === 1 },
          { id: "tap:2", label: i18n.t("推子后"), checked: (send.tap ?? 2) === 2 },
          { id: "remove", label: i18n.t("删除路由") }
        ]);
        if (choice == null) return;
        const currentChannel = state.channels?.find(item => item.id === id);
        const current = currentChannel?.sends?.[index];
        if (!current || JSON.stringify([currentChannel.chain_uuid ?? null, currentChannel.source_uuid ?? null]) !== channelIdentity || (send.id == null ? JSON.stringify(current) : sendKey(current)) !== identity) throw new Error("路由已改变，请重试");
        if (choice === "enabled") await api.channel.setSendEnabled(id, index, current.enabled === false);
        else if (choice === "remove") await api.channel.removeSend(id, index);
        else if (choice.startsWith("tap:")) await api.channel.setSendTap(id, index, Number(choice.slice(4)));
      },
      async openSendPrimary(id, index, anchor, expected) {
        const channel = state.channels?.find(item => item.id === id);
        const send = channel?.sends?.[index];
        if (!send || !Number.isInteger(index) || index < 0) throw new RangeError("send not found");
        checkSend(send, expected, channel);
        validateAnchor(anchor);
        const identity = JSON.stringify([channel.chain_uuid ?? null, channel.source_uuid ?? null]);
        const original = JSON.stringify(channel.sends);
        const outputDevices = JSON.stringify(state.graph?.output_devices ?? {});
        const outputPairs = JSON.stringify(state.graph?.output_pairs ?? []);
        const destination = send.dest;
        const backend = destination?.kind === "output" ? state.graph?.output_devices?.[destination.pair]?.backend : null;
        const output = ["asio", "wasapi", "system_output", "unavailable", "web_source", "mic_bridge"].includes(backend);
        const epoch = visibilityEpoch;
        let choice;
        let targets;
        if (output) {
          const draft = structuredClone(state.graph);
          const source = draft.chains.find(item => item.id === id);
          if (!source || !Array.isArray(source.sends)) throw new RangeError("channel not found");
          source.sends.splice(index, 1);
          targets = mockSendTargets(draft, id, i18n.t, state.sidechains).filter(item => item.dest.kind === "output");
          choice = await showMenu(anchor, targets);
        } else {
          if (typeof options.editSendGain !== "function") throw new Error("当前模拟预览不支持音量编辑");
          choice = await options.editSendGain({ value: send.level_db ?? 0, min: -60, max: state.channelControls?.gainLimit ? 0 : 6, t: i18n.t });
          if (closed) throw new Error("bridge closed");
          if (sleeping || epoch !== visibilityEpoch) return;
        }
        if (choice == null) return;
        const current = state.channels?.find(item => item.id === id);
        if (!current || JSON.stringify([current.chain_uuid ?? null, current.source_uuid ?? null]) !== identity || JSON.stringify(current.sends) !== original) throw new Error("路由已改变，请重试");
        if (!output) {
          if (!Number.isFinite(choice) || choice < -60 || choice > (state.channelControls?.gainLimit ? 0 : 6)) throw new RangeError("invalid send level");
          await api.channel.setSendLevel(id, index, choice, expected);
        } else {
          if (JSON.stringify(state.graph?.output_devices ?? {}) !== outputDevices || JSON.stringify(state.graph?.output_pairs ?? []) !== outputPairs) throw new Error("输出设备已改变，请重试");
          const selected = targets.find(item => item.id === choice);
          if (!selected) throw new RangeError("output unavailable");
          const available = mockSendTargets({ ...state.graph, chains: state.graph.chains.map(item => item.id === id ? { ...item, sends: item.sends.filter((_, i) => i !== index) } : item) }, id, i18n.t, state.sidechains).find(item => item.id === choice);
          if (!available || JSON.stringify(available.dest) !== JSON.stringify(selected.dest) || available.output_channel !== selected.output_channel) throw new Error("输出设备已改变，请重试");
          const sends = structuredClone(current.sends);
          sends[index].dest = structuredClone(available.dest);
          if (available.output_channel == null) delete sends[index].output_channel;
          else sends[index].output_channel = available.output_channel;
          if (JSON.stringify(sends) !== original) changeChannel(id, "sends", sends);
        }
      },
      async openInput(id, anchor, expectedChannel) {
        checkExpectedChannel(id, expectedChannel);
        const channel = state.channels?.find(item => item.id === id);
        const pairs = state.graph?.input_pairs;
        if (!channel || !Array.isArray(pairs)) throw new RangeError("input unavailable");
        const managed = channel.rack?.some(slot => slot.alias?.startsWith("@wdm-play-"));
        const items = [{ id: "empty", label: i18n.t("空输入"), checked: !(channel.inputs?.length) && !channel.virtual_input && !managed }];
        pairs.forEach((offset, index) => {
          const endpoint = state.graph.input_devices?.[index];
          items.push({ id: `input:${index}`, label: endpoint?.name || `${i18n.t("输入")} ${offset + 1}/${offset + 2}`, checked: channel.inputs?.includes(index) ?? false });
        });
        const offeredPairs = JSON.stringify(pairs);
        const offeredDevices = JSON.stringify(state.graph.input_devices ?? {});
        const choice = await showMenu(anchor, items);
        if (choice === "empty") await api.channel.setInput(id, null);
        else if (choice?.startsWith("input:")) {
          // An index is only valid for the same device list the menu showed.
          if (JSON.stringify(state.graph?.input_pairs) !== offeredPairs || JSON.stringify(state.graph?.input_devices ?? {}) !== offeredDevices) throw new Error("输入设备已改变，请重试");
          await api.channel.setInput(id, Number(choice.slice(6)));
        }
      },
      async openAddChannel(anchor) {
        const items = [{ id: "mono", label: i18n.t("新建单声道") }, { id: "stereo", label: i18n.t("新建双声道") }];
        if (state.graph?.chains?.some(chain => chain.hidden && !(chain.rack ?? []).some(effect => effect.alias?.startsWith("@wdm-rec-")))) items.push({ id: "show", label: i18n.t("显示隐藏通道") });
        const choice = await showMenu(anchor, items);
        if (choice === "show") await api.channel.showHidden();
        else if (choice) await api.channel.add(choice === "mono" ? 1 : 0);
      },
      async openChannelList(anchor) {
        const controls = { input:true, sends:true, phase:true, fx:true, solo:true, recording:true, effects:true, ...state.channelControls };
        const labels = [["fx", "显示 FX", "隐藏 FX"], ["solo", "显示独奏", "隐藏独奏"], ["input", "显示输入", "隐藏输入"],
          ["sends", "显示发送", "隐藏发送"], ["phase", "显示反相", "隐藏反相"], ["recording", "显示录音", "隐藏录音"]];
        const items = labels.map(([id, show, hide]) => ({ id, label:i18n.t(controls[id] ? hide : show) }));
        if (state.graph?.chains?.some(chain => chain.hidden && !(chain.rack ?? []).some(effect => effect.alias?.startsWith("@wdm-rec-")))) items.push({ id:"show", label:i18n.t("显示隐藏通道") });
        const choice = await showMenu(anchor, items);
        if (choice === "show") return api.channel.showHidden();
        if (!choice) return;
        if (!labels.some(([id]) => id === choice)) throw new RangeError("invalid channel menu choice");
        // Read again after the asynchronous menu; another action may have changed it.
        const current = { input:true, sends:true, phase:true, fx:true, solo:true, recording:true, effects:true, ...state.channelControls };
        const value = { ...current, [choice]:!current[choice] };
        state = { ...state, channelControls:value };
        notify({ type:"change", revision:++revision, key:"channelControls", value });
      },
      openInputContext: (id, anchor, expectedChannel) => api.menu.openChannel(id, anchor, expectedChannel),
      openShortcut: (id, anchor, expectedChannel) => api.menu.openChannel(id, anchor, expectedChannel),
      async openChannelSettings(id, expectedChannel) {
        checkExpectedChannel(id, expectedChannel);
        if (typeof options.showChannelProperties !== "function") throw new Error("通道设置不可用");
        const source = state.graph?.chains?.find(item => item.id === id);
        if (!source) throw new RangeError("channel not found");
        const baseline = structuredClone(source);
        if (sleeping) throw new Error("preview is sleeping");
        const epoch = visibilityEpoch;
        const draft = await options.showChannelProperties(structuredClone(source), i18n.t);
        if (sleeping || epoch !== visibilityEpoch) return;
        if (closed) throw new Error("bridge closed");
        if (draft == null) return;
        checkExpectedChannel(id, expectedChannel);
        if (typeof draft.name !== "string" || draft.name.length > 1024 ||
            ![null, "string"].includes(draft.color === null ? null : typeof draft.color) ||
            ![null, "string"].includes(draft.icon === null ? null : typeof draft.icon) ||
            (draft.color?.length ?? 0) > 64 || (draft.icon?.length ?? 0) > 64 ||
            (draft.channel_mode !== undefined && ![0, 1, 2].includes(draft.channel_mode)) ||
            (draft.ignore_latency !== undefined && typeof draft.ignore_latency !== "boolean")) throw new TypeError("invalid channel properties");
        const current = state.graph?.chains?.find(item => item.id === id);
        if (!current || !state.channels?.some(item => item.id === id)) throw new RangeError("channel not found");
        for (const field of ["name", "color", "icon", "channel_mode", "ignore_latency"]) {
          if ((current[field] ?? null) !== (baseline[field] ?? null)) throw new Error("通道属性已改变，请重试");
        }
        for (const field of ["name", "color", "icon", "channel_mode", "ignore_latency"]) {
          if (draft[field] !== undefined && (current[field] ?? null) !== draft[field]) changeChannel(id, field, draft[field]);
        }
      },
      async openChannel(id, anchor, expectedChannel) {
        checkExpectedChannel(id, expectedChannel);
        let channel = state.channels?.find(item => item.id === id);
        if (!channel) throw new RangeError("channel not found");
        const choice = await showMenu(anchor, [{ id: "mute", label: i18n.t("静音"), checked: !!channel.muted }, { id: "solo", label: i18n.t("独奏"), checked: !!channel.solo }, { id: "align", label: i18n.t(channel.align_right ? "左对齐" : "右对齐") }, { id: "hide", label: i18n.t("隐藏通道") }, { id: "properties", label: i18n.t("通道设置") }, { id: "copy", label: i18n.t("复制通道") }, { id: "remove", label: i18n.t("删除通道") }]);
        if (!choice) return;
        // The menu awaits user input; other operations may replace its target.
        channel = state.channels?.find(item => item.id === id);
        if (!channel) throw new RangeError("channel not found");
        if (choice === "mute") await api.channel.setMute(id, !channel.muted);
        else if (choice === "solo") await api.channel.setSolo(id, !channel.solo);
        else if (choice === "align") await api.channel.setAlignRight(id, !channel.align_right);
        else if (choice === "hide") await api.channel.setHidden(id, true);
        else if (choice === "properties") await api.menu.openChannelSettings(id, expectedChannel);
        else if (choice === "copy") {
          if (closed) throw new Error("bridge closed");
          const copied = copyMockChannel(state.graph, state.channels, state.primary, state.sidechains, id, options.createIdentity);
          const copiedInfo = [...copied.mapping].filter(([original]) => state.effectInfo?.[original]).map(([original, instance]) => [instance, structuredClone(state.effectInfo[original])]);
          publishStructure(copied.channels, copied.chains);
          if (copiedInfo.length) {
            state = { ...state, effectInfo: { ...state.effectInfo, ...Object.fromEntries(copiedInfo) } };
            notify({ type: "change", revision: ++revision, key: "effectInfo", value: state.effectInfo });
          }
          for (const [instance, parameter] of copied.primary) {
            state = { ...state, primary: { ...state.primary, [instance]: parameter } };
            notify({ type: "primary", revision: ++revision, instance, parameter });
          }
          if (JSON.stringify(copied.sidechains) !== JSON.stringify(state.sidechains)) {
            state = { ...state, sidechains: copied.sidechains };
            notify({ type: "change", revision: ++revision, key: "sidechains", value: copied.sidechains });
          }
        }
        else if (choice === "remove") await api.channel.remove(id);
      },
      async openEffect(id, instance, anchor, expected) {
        const channel = state.channels?.find(item => item.id === id);
        let effect = channel?.rack?.find(item => item.instance === instance);
        if (!effect) throw new RangeError("effect not found");
        checkExpectedEffect(id, effect, expected);
        const choice = await showMenu(anchor, [{ id: "bypass", label: i18n.t("旁通"), checked: !!effect.bypass }, { id: "up", label: i18n.t("skin.move_up") }, { id: "down", label: i18n.t("skin.move_down") }, { id: "remove", label: i18n.t("skin.remove") }]);
        if (!choice) return;
        effect = state.channels?.find(item => item.id === id)?.rack?.find(item => item.instance === instance);
        if (!effect) throw new RangeError("effect not found");
        if (choice === "bypass") await api.effect.setBypass(id, instance, !effect.bypass);
        else if (choice === "up" || choice === "down") {
          const current = state.channels?.find(item => item.id === id)?.rack ?? [];
          const group = linkGroup(state.graph?.chains?.find(item => item.id === id)?.mute_group);
          const linked = group && state.graph.link_groups?.[group]?.slots;
          const rows = linked ? linkedSlotRows(state.graph, id) : current;
          const position = rows.findIndex(item => item?.instance === instance);
          if (position < 0) throw new RangeError("effect not found");
          const next = position + (choice === "up" ? -1 : 1);
          if (next >= 0 && next < rows.length) {
            if (linked) await api.effect.moveSlot(id, instance, next);
            else await api.effect.move(id, instance, next);
          }
        }
        else if (choice === "remove") await api.effect.remove(id, instance);
      }
    }),
    close() { closed = true; visibility?.removeEventListener("visibilitychange", visibilityChanged); listeners.clear(); meterListeners.clear(); noticeListeners.clear(); boundsListeners.clear(); parameterListeners.clear(); parameterUpdates.clear(); i18n.clear(); },
    fixture: Object.freeze({
      patch(changes) {
        if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new TypeError("invalid patch");
        const copied = structuredClone(changes);
        state = { ...state, ...copied };
        revision += 1;
        notify({ type: "patch", revision, changes: copied });
      },
      update(key, value) {
        if (typeof key !== "string" || !key) throw new TypeError("key must be a nonempty string");
        const copied = structuredClone(value);
        state = { ...state, [key]: copied };
        revision += 1;
        notify({ type: "change", revision, key, value: copied });
      },
      snapshot,
      commands() { return structuredClone(commands); },
      publishEffectParameters(updates) {
        if (closed || !Array.isArray(updates)) return;
        for (const update of updates) parameterUpdates.set(update.instance, structuredClone(update));
        notifyParameters(updates);
      },
      publishNotice(message) {
        if (sleeping || closed || typeof message !== "string") return;
        for (const listener of [...noticeListeners]) if (noticeListeners.has(listener)) listener({ level: "error", message });
      },
      publishRecordingSaved(name, token = 1) {
        if (sleeping || closed || typeof name !== "string" || !Number.isSafeInteger(token) || token < 1) return;
        for (const listener of [...noticeListeners]) if (noticeListeners.has(listener)) listener({ level: "recording_saved", name, token });
      },
      expireRecordingNotice() {
        if (sleeping || closed) return;
        for (const listener of [...noticeListeners]) if (noticeListeners.has(listener)) listener({ level: "recording_expired" });
      },
      publishMeters(meters) {
        if (sleeping || closed) return;
        for (const listener of [...meterListeners]) {
          if (meterListeners.has(listener)) listener(structuredClone(meters).map(meter => {
            if (!meterLoudness) { delete meter.loudness; delete meter.stereo_loudness; }
            else {
              if (!Number.isFinite(meter.loudness)) delete meter.loudness;
              if (Array.isArray(meter.stereo_loudness) && meter.stereo_loudness.length === 2) {
                const values = meter.stereo_loudness.map(value => Number.isFinite(value) ? value : null);
                if (values.some(value => value !== null)) meter.stereo_loudness = values;
                else delete meter.stereo_loudness;
              } else delete meter.stereo_loudness;
            }
            return meter;
          }));
        }
      },
      close() { api.close(); }
    })
  };
  return Object.freeze(api);
}
