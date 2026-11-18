import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMockAudcore } from "./support/mock-audcore.mjs";

class Element {
    constructor() {
      this.children = [];
      this.attributes = {};
      this.events = {};
      this.style = { setProperty(name, value) { this[name] = value; } };
    }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    insertBefore(node, before) {
      if (node.parent) node.remove();
      node.parent = this;
      const index = before ? this.children.indexOf(before) : -1;
      this.children.splice(index < 0 ? this.children.length : index, 0, node);
    }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    toggleAttribute(name, enabled) { if (enabled) this.setAttribute(name, ""); else this.removeAttribute(name); }
    get parentElement() { return this.parent; }
    closest(selector) {
      const attribute = selector.match(/^\[([\w-]+)\]$/)?.[1];
      if (!attribute) return null;
      if (this.getAttribute(attribute) !== null) return this;
      return this.parent?.closest(selector) ?? null;
    }
    focus() { if (globalThis.document) globalThis.document.activeElement = this; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(type, handler) { this.events[type] = handler; }
    getBoundingClientRect() { return { left: 12, bottom: 34 }; }
}

// Exercise the actual page module without starting or controlling a GUI.

test("X AIR reuses host routing, gain and document operations", async () => {
  const ids = ["skin-root", "channels", "channel-list", "system-menu", "add-channel", "transport", "settings", "audio-status",
    "status", "toolbar", "window-drag", "window-minimize", "window-maximize", "window-close", "xair-routing",
    "xair-routing-title", "xair-empty", "xair-save", "xair-open", "xair-sidebar-status", "xair-selection-number", "xair-selection-name", "xair-mixer-viewport"];
  class MixerElement extends Element {
    click() { this.events.click?.({ currentTarget: this }); }
    setPointerCapture(id) { this.capturedPointer = id; }
    select() {}
    scrollIntoView() { this.scrolled = true; }
    blur() {
      document.activeElement = null;
      this.events.blur?.();
    }
  }
  const nodes = Object.fromEntries(ids.map(id => [id, new MixerElement()]));
  const actions = Object.fromEntries(["mixer", "channel", "input", "effects", "sends", "meters", "solo"].map(action => {
    const element = new MixerElement();
    element.setAttribute("data-mixer-action", action);
    return [action, element];
  }));
  actions.mixer.setAttribute("aria-pressed", "true");
  actions.meters.setAttribute("aria-pressed", "false");
  const html = new MixerElement();
  html.setAttribute("data-skin", "xair");
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const outputName = "主混音与直播监听";
  const deviceName = "Analog Input 3/4 · USB Audio Interface";
  const channels = [
    { id: 1, chain_uuid: "a", name: "Mic", gainDb: 0, rack: [], sends: [{ dest: { kind: "chain", id: 2 }, level_db: Math.fround(-13.1) }] },
    { id: 2, chain_uuid: "b", name: outputName, align_right: true, gainDb: -9, rack: [], sends: [] },
    { id: 3, name: "人声湿声", rack: [], sends: [] },
    { id: 4, name: "人声混音组", rack: [], sends: [] },
    { id: 5, name: "主混音总输出", rack: [], sends: [] },
    ...Array.from({ length: 7 }, (_, index) => ({ id: index + 6, name: `Input ${index + 6}`, rack: [], sends: [] })),
  ];
  const calls = [];
  const host = createMockAudcore({ channels, graph: { chains: channels }, inputLabels: { 1: deviceName }, i18n: { language: "en", messages: {} } });
  const hiddenControls = { input: false, sends: false, effects: false, phase: false, fx: false, solo: false, recording: false, gainLimit: true };
  host.fixture.update("channelControls", hiddenControls);
  try {
    const documentEvents = {};
    const windowEvents = {};
    const viewport = nodes["xair-mixer-viewport"];
    viewport.offsetHeight = viewport.clientHeight = 677;
    let hit;
    globalThis.document = {
      hidden: false, documentElement: html, getElementById: id => nodes[id], createElement: () => new MixerElement(),
      addEventListener(type, handler) { documentEvents[type] = handler; }, removeEventListener() {},
      querySelectorAll: selector => selector === "[data-mixer-action]" ? Object.values(actions) : [],
      elementFromPoint: () => hit,
    };
    globalThis.window = {
      innerHeight: 713,
      addEventListener(type, handler) { windowEvents[type] = handler; }, removeEventListener() {},
      location: { hash: "#audcore-native-frame" },
      audcore: {
        ...host,
        menu: { ...host.menu, async openInput(id) { calls.push(["input", id]); },
          async openChannelSettings(id) { calls.push(["settings", id]); } },
        document: { async save() { calls.push(["save"]); } },
      },
    };
    await import("../web/page.mjs?xair-test");
    assert.equal(html.getAttribute("data-native-frame"), "");
    assert.equal(nodes["window-close"].events.click, undefined);
    assert.equal(nodes["window-drag"].parentElement, nodes["xair-sidebar-status"]);
    const [mic, main] = nodes.channels.children;
    const byClass = (row, name) => row.children.find(element => element.className === name);
    assert.deepEqual(nodes.channels.children.slice(2, 5).map(row => byClass(row, "name").textContent),
      ["人声\n湿声", "人声混\n音组", "主混音\n总输出"]);
    const effectBox = byClass(mic, "xair-box xair-effects");
    const sendBox = byClass(mic, "xair-box xair-sends");
    const fixedControls = [byClass(mic, "input"), effectBox.children[1], sendBox.children[1],
      byClass(mic, "xair-utility").children[0], effectBox.children[0].children[0],
      mic.children.find(element => element.getAttribute("data-control") === "solo"), byClass(mic, "xair-monitor").children[0]];
    assert.ok(fixedControls.every(element => element && !element.hidden));
    assert.equal(actions.solo.disabled, false);
    host.fixture.update("channelControls", {});
    host.fixture.update("channelControls", hiddenControls);
    assert.ok(fixedControls.every(element => !element.hidden));
    assert.equal(mic.getAttribute("data-selected"), "");
    assert.equal(main.getAttribute("data-xair-pinned"), "");
    assert.equal(nodes["xair-routing"].children[0].textContent, outputName);
    assert.equal(main.children.find(element => element.className === "name").title, outputName);
    assert.equal(mic.children.find(element => element.className === "input").title, deviceName);
    const send = sendBox.children[1].children[0];
    assert.equal(send.textContent, `${outputName} · -13.1 dB`);
    assert.equal(send.title, send.textContent);
    actions.input.click();
    main.events.pointerdown();
    actions.input.click();
    nodes["xair-save"].click();
    actions.meters.click();
    assert.equal(nodes["skin-root"].getAttribute("data-xair-view"), "meters");
    assert.deepEqual(calls, [["input", 1], ["input", 2], ["save"]]);
    assert.equal(nodes["skin-root"].style["--xair-fader-height"], "220px");
    viewport.clientHeight -= 8;
    windowEvents.resize();
    assert.equal(nodes["skin-root"].style["--xair-fader-height"], "212px");
    assert.equal(nodes["xair-selection-number"].textContent, "02");
    assert.equal(nodes["xair-selection-name"].textContent, outputName);
    const press = (key, timeStamp, target) => {
      let handled = false;
      documentEvents.keydown({ key, timeStamp, target, preventDefault() { handled = true; } });
      return handled;
    };
    assert.equal(press("1", 100), true);
    assert.equal(nodes["xair-selection-number"].textContent, "01");
    assert.equal(press("2", 200), true);
    assert.equal(nodes["xair-selection-number"].textContent, "12");
    assert.equal(nodes["xair-selection-name"].textContent, "Input 12");
    assert.equal(nodes.channels.children[11].scrolled, true);
    assert.equal(press("3", 300, { tagName: "INPUT", type: "text" }), false);
    assert.equal(nodes["xair-selection-number"].textContent, "12");

    const db = main.children.find(element => element.className === "xair-db");
    db.focus();
    db.events.focus();
    db.value = "−12.5 dB";
    db.events.keydown({ key: "Enter", preventDefault() {} });
    assert.equal(host.fixture.snapshot().state.channels[1].gainDb, -12.5);
    db.focus();
    db.events.focus();
    db.value = "9";
    db.events.keydown({ key: "Escape", preventDefault() {} });
    assert.equal(db.value, "-12.5");
    assert.equal(host.fixture.snapshot().state.channels[1].gainDb, -12.5);
    db.focus();
    db.events.focus();
    db.value = "2";
    db.events.keydown({ key: "Enter", preventDefault() {} });
    assert.equal(host.fixture.snapshot().state.channels[1].gainDb, -12.5);

    const label = byClass(mic, "name");
    const third = nodes.channels.children[2];
    const pointer = { button: 0, pointerId: 9, clientX: 15, clientY: 20 };
    const moved = { ...pointer, clientX: 125 };
    const order = () => host.fixture.snapshot().state.channels.slice(0, 3).map(({ id }) => id);
    assert.equal(label.getAttribute("draggable"), null);
    label.events.pointerdown(pointer);
    assert.equal(label.capturedPointer, 9);
    hit = byClass(main, "name");
    label.events.pointermove(moved);
    assert.equal(main.getAttribute("data-channel-drop-target"), null);
    label.events.pointerup({ ...moved, type: "pointerup" });
    assert.deepEqual(order(), [1, 2, 3]);
    label.events.pointerdown(pointer);
    hit = byClass(third, "name");
    label.events.pointermove(moved);
    assert.equal(third.getAttribute("data-channel-drop-target"), "");
    label.events.pointercancel({ ...moved, type: "pointercancel" });
    assert.equal(third.getAttribute("data-channel-drop-target"), null);
    assert.deepEqual(order(), [1, 2, 3]);
    label.events.pointerdown(pointer);
    label.events.pointermove(moved);
    label.events.pointerup({ ...moved, type: "pointerup" });
    assert.equal(third.getAttribute("data-channel-drop-target"), null);
    assert.deepEqual(order(), [2, 3, 1]);
    label.events.click({ detail: 1 });
    assert.equal(calls.some(([name]) => name === "settings"), false);
    label.events.pointerdown(pointer);
    label.events.pointerup({ ...pointer, type: "pointerup" });
    label.events.click({ detail: 1 });
    assert.deepEqual(calls.at(-1), ["settings", 1]);
  } finally {
    host.close();
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
