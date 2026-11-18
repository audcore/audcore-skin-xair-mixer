import { createI18nCache } from "./i18n-cache.mjs";

// WebView2 adapter draft. The C++ host must enforce origin, message limits and
// method permissions; this adapter does not turn untrusted code into trusted code.
export function createWebViewAudcore(webview, { timeoutMs = 10000, nativeStartup = true, visibility = null } = {}) {
  if (!webview || typeof webview.postMessage !== "function") throw new TypeError("WebView2 bridge unavailable");
  // The native limit includes the document transport's comma, property name
  // and 32-character token. Reserve those 46 ASCII bytes before accepting a
  // request so an otherwise valid near-limit message is not lost by WebView2.
  const maxRequestBytes = 1024 * 1024 - 46;
  const encoder = new TextEncoder();
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const listeners = new Set();
  const meterListeners = new Set();
  const parameterListeners = new Set();
  const noticeListeners = new Set();
  const boundsListeners = new Set();
  const i18n = createI18nCache();
  let editActive = false;
  let editEpoch = 0;
  let stateRevision = -1;
  let stateDesynced = false;
  // Native UI calls can legitimately wait indefinitely for a person. They are
  // released by the host response or by close(), not by the command timeout.
  const interactive = new Set(["document.open", "document.save", "performance.open", "effect.openBrowser", "effect.openEditor", "effect.copyTo", "effect.insertDroppedFile", "audio.dropFile", "menu.openSystem", "menu.openTransport", "menu.openAddSend", "menu.openSend", "menu.openSendPrimary", "menu.openInput", "menu.openAddChannel", "menu.openChannelList", "menu.openChannel", "menu.openChannelSettings", "menu.openInputContext", "menu.openEffect", "menu.openRecording", "menu.openLink", "menu.openLinkSettings", "menu.openShortcut", "menu.openSolo", "window.startDrag", "window.startResize"]);

  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  function armTimeout(id, entry) {
    if (entry.remaining === null || visibility?.hidden || entry.timer !== null) return;
    entry.started = clock();
    entry.timer = setTimeout(() => {
      entry.timer = null;
      pending.delete(id);
      try { webview.cancelRequest?.(id); } catch { /* The request still times out if the transport is gone. */ }
      entry.reject(new Error(`request timed out: ${entry.method}`));
    }, entry.remaining);
  }
  function pauseTimeout(entry) {
    if (entry.timer === null) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.remaining = Math.max(0, entry.remaining - (clock() - entry.started));
  }

  function request(method, params = {}, file = undefined) {
    if (closed) return Promise.reject(new Error("bridge closed"));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method, timer: null, started: 0, remaining: interactive.has(method) ? null : timeoutMs };
      pending.set(id, entry);
      armTimeout(id, entry);
      try {
        const message = { version: 1, type: "request", id, method, params };
        const json = JSON.stringify(message);
        // A UTF-16 code unit needs at most three UTF-8 bytes. Most short
        // interactions avoid allocation; large ones are measured precisely.
        if (json.length > maxRequestBytes ||
            (json.length > maxRequestBytes / 3 && encoder.encode(json).length > maxRequestBytes)) {
          throw new RangeError("request too large");
        }
        if (file !== undefined) {
          if (typeof webview.postTargetFileDrop !== "function") throw new Error("file drop unavailable");
          webview.postTargetFileDrop(message, file);
        } else webview.postMessage(message);
      } catch (error) {
        clearTimeout(entry.timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function receive(event) {
    const message = event.data;
    if (!message || message.version !== 1) return;
    if (message.type === "response") {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(String(message.error)));
      else request.resolve(message.result);
    } else if (message.type === "notice" && message.level === "edit_cancelled") {
      editActive = false;
      ++editEpoch;
    } else if (message.type === "notice" && ["error", "info"].includes(message.level) && typeof message.message === "string") {
      for (const listener of [...noticeListeners]) {
        if (noticeListeners.has(listener)) listener({ level: message.level, message: message.message });
      }
    } else if (message.type === "notice" && message.level === "recording_saved" && typeof message.name === "string" && Number.isSafeInteger(message.token) && message.token > 0) {
      for (const listener of [...noticeListeners]) {
        if (noticeListeners.has(listener)) listener({ level: message.level, name: message.name, token: message.token });
      }
    } else if (message.type === "notice" && message.level === "recording_expired") {
      for (const listener of [...noticeListeners]) {
        if (noticeListeners.has(listener)) listener({ level: message.level });
      }
    } else if (message.type === "windowBounds" && message.bounds && typeof message.bounds === "object") {
      for (const listener of [...boundsListeners]) if (boundsListeners.has(listener)) listener(message.bounds);
    } else if (message.type === "meters" && Array.isArray(message.meters)) {
      for (const listener of [...meterListeners]) {
        if (meterListeners.has(listener)) listener(message.meters);
      }
    } else if (message.type === "effectParameters" && Array.isArray(message.updates) && !stateDesynced) {
      for (const listener of parameterListeners) listener(message.updates);
    } else if (message.type === "state") {
      const update = message.event;
      const snapshot = update?.type === "snapshot" && Number.isSafeInteger(update.revision) && update.revision >= stateRevision;
      const delta = ["change", "patch", "graph_patch", "channel", "channel_batch", "effect_batch", "order", "structure", "primary"].includes(update?.type) && update?.revision === stateRevision + 1;
      if (snapshot) {
        stateRevision = update.revision;
        stateDesynced = false;
        i18n.clear();
        i18n.update(update.state?.i18n);
      } else if (!stateDesynced && delta) {
        stateRevision = update.revision;
        if (update.type === "change" && update.key === "i18n") i18n.update(update.value);
        else if (update.type === "patch" && update.changes?.i18n) i18n.update(update.changes.i18n);
      } else {
        stateDesynced = true;
      }
      for (const listener of [...listeners]) {
        if (listeners.has(listener)) listener(message.event);
      }
    }
  }

  function endEditing() {
    if (!editActive) return Promise.resolve();
    editActive = false;
    const epoch = ++editEpoch;
    return request("history.endEdit").catch(error => {
      if (!closed && editEpoch === epoch) editActive = true;
      throw error;
    });
  }
  const onVisibilityChange = () => {
    if (visibility?.hidden) {
      for (const entry of pending.values()) pauseTimeout(entry);
      endEditing().catch(() => {});
    } else {
      for (const [id, entry] of pending) armTimeout(id, entry);
    }
  };
  webview.addEventListener("message", receive);
  visibility?.addEventListener("visibilitychange", onVisibilityChange);
  const storage = area => Object.freeze({
    get: key => request(`${area}.storage.get`, { key }),
    set: (key, value) => request(`${area}.storage.set`, { key, value }),
    remove: key => request(`${area}.storage.remove`, { key }),
    keys: () => request(`${area}.storage.keys`),
    clear: () => request(`${area}.storage.clear`)
  });
  return Object.freeze({
    local: Object.freeze({ storage: storage("local") }),
    i18n: Object.freeze({ getLanguage: i18n.getLanguage, t: i18n.t, setLanguage: language => request("i18n.setLanguage", { language }) }),
    notifications: Object.freeze({
      subscribe(listener) {
        if (typeof listener !== "function") throw new TypeError("listener must be a function");
        if (closed) throw new Error("bridge closed");
        noticeListeners.add(listener);
        return () => noticeListeners.delete(listener);
      }
    }),
    state: Object.freeze({
      resync: () => request("state.resync"),
      // Subscribe before requesting the snapshot so no early host event is lost.
      async subscribe(listener, { effectParameters = false } = {}) {
        if (typeof listener !== "function") throw new TypeError("listener must be a function");
        if (listeners.size) throw new Error("only one state subscription is supported");
        stateRevision = -1;
        stateDesynced = false;
        i18n.clear();
        listeners.add(listener);
        try {
          await request("state.subscribe", effectParameters ? { effectParameters: true } : {});
        } catch (error) {
          listeners.delete(listener);
          i18n.clear();
          // A lost acknowledgement does not mean the host failed to subscribe.
          if (!closed) request("state.unsubscribe").catch(() => {});
          throw error;
        }
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          listeners.delete(listener);
          i18n.clear();
          if (!closed && listeners.size === 0) {
            // Unsubscribe also ends the host transaction. Invalidate late
            // acknowledgements before a new subscription can begin editing.
            const wasEditing = editActive;
            editActive = false;
            ++editEpoch;
            if (wasEditing) request("history.endEdit").catch(() => {});
            request("state.unsubscribe").catch(() => {});
          }
        };
      }
    }),
    transport: Object.freeze({ setPlaying: playing => request("transport.setPlaying", { playing }) }),
    recording: Object.freeze({ revealSaved: token => request("recording.revealSaved", { token }) }),
    channel: Object.freeze({
      add: mode => request("channel.add", { mode }),
      addNode: (kind, index, binding) => request("channel.addNode", { kind, index, binding }),
      remove: (id, expectedChannel) => request("channel.remove", { id, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      setMute: (id, muted, expectedChannel) => request("channel.setMute", { id, muted, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      setSolo: (id, solo, expectedChannel) => request("channel.setSolo", { id, solo, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      setSoloSafe: (id, safe, expectedChannel) => request("channel.setSoloSafe", { id, safe, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      setGain: (id, db, expectedChannel) => request("channel.setGain", { id, db, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      setRecording: (id, recording, expectedChannel) => request("channel.setRecording", { id, recording, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      setPhase: (id, degrees, expectedChannel) => request("channel.setPhase", { id, degrees, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      setFxBypass: (id, bypass, expectedChannel) => request("channel.setFxBypass", { id, bypass, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      setSendLevel: (id, index, db, expected) => request("channel.setSendLevel", { id, index, db, ...(expected === undefined ? {} : { expected }) }),
      setSendEnabled: (id, index, enabled, expected) => request("channel.setSendEnabled", { id, index, enabled, ...(expected === undefined ? {} : { expected }) }),
      setSendTap: (id, index, tap, expected) => request("channel.setSendTap", { id, index, tap, ...(expected === undefined ? {} : { expected }) }),
      removeSend: (id, index, expected) => request("channel.removeSend", { id, index, ...(expected === undefined ? {} : { expected }) }),
      removeSends: routes => request("channel.removeSends", { routes }),
      moveSend: (id, from, to, expected, expectedChannel) => request("channel.moveSend", { id, from, to, expected, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      addSend: (id, targetId, expectedChannel) => request("channel.addSend", { id, targetId, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      setName: (id, name, expectedChannel) => request("channel.setName", { id, name, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      setHidden: (id, hidden, expectedChannel) => request("channel.setHidden", { id, hidden, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      setInput: (id, index, expectedChannel) => request("channel.setInput", { id, index, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      showHidden: () => request("channel.showHidden"),
      setAlignRight: (id, right, expectedChannel) => request("channel.setAlignRight", { id, right, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      setOrder: (ids, expected) => request("channel.setOrder", { ids, ...(expected !== undefined && { expected }) })
    }),
    appearance: Object.freeze({
      setTheme: theme => request("appearance.setTheme", { theme }),
      setScale: scale => request("appearance.setScale", { scale })
    }),
    effect: Object.freeze({
      onParameters(listener) {
        if (typeof listener !== "function") throw new TypeError("listener must be a function");
        if (closed) throw new Error("bridge closed");
        parameterListeners.add(listener);
        return () => parameterListeners.delete(listener);
      },
      openBrowser: (id, expectedChannel) => request("effect.openBrowser", { id, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      openEditor: (id, instance, expectedEffect) => request("effect.openEditor", { id, instance, ...(expectedEffect === undefined ? {} : { expectedEffect }) }),
      move: (id, instance, index, expectedEffect, expectedTarget) => request("effect.move", { id, instance, index, ...(expectedEffect === undefined ? {} : { expectedEffect }), ...(expectedTarget === undefined ? {} : { expectedTarget }) }),
      copyTo: (id, instance, target, index, expectedEffect, expectedChannel, expectedRack) => request("effect.copyTo", { id, instance, target, index, expectedEffect, expectedChannel, expectedRack }),
      insertDroppedFile: (file, channel, index, expectedChannel, expectedRack) => !file || typeof file !== "object"
        ? Promise.reject(new TypeError("invalid dropped file"))
        : request("effect.insertDroppedFile", { channel, index, expectedChannel, expectedRack }, file),
      moveSlot: (id, instance, index, expectedEffect, expectedTarget) => request("effect.moveSlot", { id, instance, index, ...(expectedEffect === undefined ? {} : { expectedEffect }), ...(expectedTarget === undefined ? {} : { expectedTarget }) }),
      setBypass: (id, instance, bypass, expectedEffect) => request("effect.setBypass", { id, instance, bypass, ...(expectedEffect === undefined ? {} : { expectedEffect }) }),
      setWet: (id, instance, wet, expectedEffect) => request("effect.setWet", { id, instance, wet, ...(expectedEffect === undefined ? {} : { expectedEffect }) }),
      setPrimary: (id, instance, parameter, normalized, expectedEffect) => request("effect.setPrimary", { id, instance, parameter, normalized, ...(expectedEffect === undefined ? {} : { expectedEffect }) }),
      resetPrimary: (id, instance, parameter, expectedEffect) => request("effect.resetPrimary", { id, instance, parameter, ...(expectedEffect === undefined ? {} : { expectedEffect }) }),
      remove: (id, instance, expectedEffect) => request("effect.remove", { id, instance, ...(expectedEffect === undefined ? {} : { expectedEffect }) })
    }),
    audio: Object.freeze({
      dropFile: (file, channel, expectedChannel) => !file || typeof file !== "object"
        ? Promise.reject(new TypeError("invalid dropped file"))
        : request("audio.dropFile", { channel, ...(expectedChannel === undefined ? {} : { expectedChannel }) }, file)
    }),
    meters: Object.freeze({
      setLoudness: enabled => request("meters.setLoudness", { enabled }),
      async subscribe(listener, options = {}) {
        if (typeof listener !== "function") throw new TypeError("listener must be a function");
        if (meterListeners.size) throw new Error("only one meter subscription is supported");
        if (!options || typeof options !== "object" || Array.isArray(options) || (options.loudness !== undefined && typeof options.loudness !== "boolean")) throw new TypeError("invalid meter options");
        meterListeners.add(listener);
        try {
          await request("meters.subscribe", options.loudness ? { loudness: true } : {});
        } catch (error) {
          meterListeners.delete(listener);
          if (!closed) request("meters.unsubscribe").catch(() => {});
          throw error;
        }
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          meterListeners.delete(listener);
          if (!closed) request("meters.unsubscribe").catch(() => {});
        };
      }
    }),
    history: Object.freeze({
      beginEdit() {
        if (editActive) return Promise.reject(new Error("edit already active"));
        editActive = true;
        const epoch = ++editEpoch;
        return request("history.beginEdit").catch(error => {
          if (editEpoch === epoch) {
            editActive = false;
            ++editEpoch;
            // The host may have begun editing even if its acknowledgement was lost.
            if (!closed) request("history.endEdit").catch(() => {});
          }
          throw error;
        });
      },
      endEdit: endEditing,
      undo: () => request("history.undo"),
      redo: () => request("history.redo")
    }),
    document: Object.freeze({
      storage: storage("document"),
      new: () => request("document.new"),
      open: () => request("document.open"),
      save: () => request("document.save")
    }),
    settings: Object.freeze({ open: () => request("settings.open") }),
    window: Object.freeze({
      requiresStartup: () => nativeStartup,
      showUnderCover: () => { if (nativeStartup && !closed) webview.postMessage({ version: 1, type: "startup", phase: "show" }); },
      presentFrame: () => { if (nativeStartup && !closed) webview.postMessage({ version: 1, type: "startup", phase: "complete" }); },
      startupFailed: () => { if (nativeStartup && !closed) webview.postMessage({ version: 1, type: "startup", phase: "failed" }); },
      getBounds: () => request("window.getBounds"),
      getDisplays: () => request("window.getDisplays"),
      setAlwaysOnTop: enabled => request("window.setAlwaysOnTop", { enabled }),
      async subscribeBounds(listener) {
        if (typeof listener !== "function") throw new TypeError("listener must be a function");
        if (boundsListeners.size) throw new Error("only one bounds subscription is supported");
        boundsListeners.add(listener);
        try { const bounds = await request("window.bounds.subscribe"); if (boundsListeners.has(listener)) listener(bounds); }
        catch (error) { boundsListeners.delete(listener); if (!closed) request("window.bounds.unsubscribe").catch(() => {}); throw error; }
        let active = true;
        return () => { if (active) { active = false; boundsListeners.delete(listener); if (!closed) request("window.bounds.unsubscribe").catch(() => {}); } };
      },
      setBounds: bounds => request("window.setBounds", bounds),
      minimize: () => request("window.minimize"),
      toggleMaximize: () => request("window.toggleMaximize"),
      close: () => request("window.close"),
      startDrag: () => request("window.startDrag"),
      startResize: direction => request("window.startResize", { direction })
    }),
    performance: Object.freeze({ open: () => request("performance.open") }),
    menu: Object.freeze({
      openSystem: anchor => request("menu.openSystem", { anchor }),
      openTransport: anchor => request("menu.openTransport", { anchor }),
      openAddSend: (id, anchor, expectedChannel) => request("menu.openAddSend", { id, anchor, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      openSend: (id, index, anchor, expected) => request("menu.openSend", { id, index, anchor, ...(expected === undefined ? {} : { expected }) }),
      openSendPrimary: (id, index, anchor, expected) => request("menu.openSendPrimary", { id, index, anchor, ...(expected === undefined ? {} : { expected }) }),
      openInput: (id, anchor, expectedChannel) => request("menu.openInput", { id, anchor, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      openAddChannel: anchor => request("menu.openAddChannel", { anchor }),
      openChannelSettings: (id, expectedChannel) => request("menu.openChannelSettings", { id, expectedChannel }),
      openChannelList: anchor => request("menu.openChannelList", { anchor }),
      openChannel: (id, anchor, expectedChannel, inputContext = false) => request("menu.openChannel", { id, anchor, ...(expectedChannel === undefined ? {} : { expectedChannel }), ...(inputContext ? { inputContext: true } : {}) }),
      openInputContext: (id, anchor, expectedChannel) => request("menu.openInputContext", { id, anchor, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      openShortcut: (id, anchor, expectedChannel) => request("menu.openShortcut", { id, anchor, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      openRecording: (id, anchor, expectedChannel) => request("menu.openRecording", { id, anchor, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      openLink: (id, anchor, expectedChannel) => request("menu.openLink", { id, anchor, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      openLinkSettings: (id, anchor, expectedChannel) => request("menu.openLinkSettings", { id, anchor, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      openSolo: (id, anchor, expectedChannel) => request("menu.openSolo", { id, anchor, ...(expectedChannel === undefined ? {} : { expectedChannel }) }),
      openEffect: (id, instance, anchor, expectedEffect) => request("menu.openEffect", { id, instance, anchor, ...(expectedEffect === undefined ? {} : { expectedEffect }) })
    }),
    close({ releaseHost = true } = {}) {
      if (closed) return;
      // The host can outlive this document across navigations. Send releases
      // before closing even when page teardown owns no individual stop handles.
      if (releaseHost && editActive) request("history.endEdit").catch(() => {});
      editActive = false;
      ++editEpoch;
      if (releaseHost && listeners.size) request("state.unsubscribe").catch(() => {});
      if (releaseHost && meterListeners.size) request("meters.unsubscribe").catch(() => {});
      if (releaseHost && boundsListeners.size) request("window.bounds.unsubscribe").catch(() => {});
      closed = true;
      visibility?.removeEventListener("visibilitychange", onVisibilityChange);
      webview.removeEventListener("message", receive);
      listeners.clear();
      meterListeners.clear();
      parameterListeners.clear();
      noticeListeners.clear();
      boundsListeners.clear();
      i18n.clear();
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("bridge closed"));
      }
      pending.clear();
    }
  });
}
