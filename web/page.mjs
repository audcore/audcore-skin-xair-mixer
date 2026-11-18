import { channelDisplayName, compactInputLabel, compactOutputLabel } from "./channel-name.mjs";
import { channelDisplayColor } from "./channel-color.mjs";
import { localizeHostError, mountSkin } from "./skin.mjs";
import { revealNativeCover } from "./startup.mjs";
import { createWebViewAudcore } from "./webview-bridge.mjs";
import { mountMeters } from "./meters.mjs";
import { compactSidechainLabel, sendLabel } from "./send-label.mjs";
import { channelSendTargets } from "./send-targets.mjs";
import { isRouteBridge, linkedSlotRows, normalizeLink } from "./link-slots.mjs";
import { bindWindowControls } from "./window-controls.mjs";
import { createLatencyCalculator, latencyNeedsUpdate } from "./latency.mjs";
import { createTransportControl } from "./transport-control.mjs";
import { createPendingToggles } from "./pending-toggle.mjs";

let ownsHost = false;
if (!window.audcore && window.__AUDCORE_NATIVE_MOCK__) {
  window.audcore = createWebViewAudcore(window.chrome.webview, { visibility: document });
  ownsHost = true;
}

// The published skin uses the host bridge. Browser-only simulation is loaded
// on demand and stays outside the installable skin package.
if (!window.audcore) throw new Error("请在声核中安装并打开此皮肤");
const preview = null;
const host = window.audcore ?? preview.host;
if (!window.audcore) {
  window.audcore = host;
  ownsHost = true;
}
const skinRoot = document.getElementById("skin-root");
const layout = document.documentElement?.getAttribute("data-skin");
const rackSkin = layout === "rack";
const hudSkin = layout === "hud";
const hud = null;
const studioV2 = layout === "studio-v2";
const studioSkin = hudSkin || layout === "studio" || studioV2;
const studioScale = null;
const xairSkin = layout === "xair";

const nativeFrame = xairSkin && !preview && window.location?.hash === "#audcore-native-frame";
if (nativeFrame) document.documentElement.setAttribute("data-native-frame", "");
const xairFader = (xairSkin) ? await import("./xair-fader.mjs") : null;
if (xairSkin && Number.isFinite(window.innerHeight)) {
  const mixerViewport = document.getElementById("xair-mixer-viewport");
  const resizeXair = () => {
    const height = window.innerHeight;
    const { scale, viewport } = xairFader.xairLayout(height, nativeFrame);
    skinRoot.style.setProperty("--xair-pixel-scale", String(scale));
    skinRoot.style.setProperty("--xair-viewport-height", `${viewport}px`);
    const scrollbarHeight = Math.max(0, mixerViewport.offsetHeight - mixerViewport.clientHeight);
    const { effects, fader } = xairFader.xairLayout(height, nativeFrame, scrollbarHeight);
    skinRoot.style.setProperty("--xair-fx-height", `${effects}px`);
    skinRoot.style.setProperty("--xair-fader-height", `${fader}px`);
  };
  window.addEventListener("resize", resizeXair);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(resizeXair).observe(mixerViewport);
  resizeXair();
}
const numericGain = (xairSkin);
const hasEffectControls = (studioSkin);
const hasSendDrag = (rackSkin || xairSkin);
const hasChannelSettingsButton = (rackSkin || studioSkin || xairSkin);
if (hasSendDrag) {
  const updateModifier = event => skinRoot.toggleAttribute("data-adjust-modifier", event.ctrlKey === true);
  for (const type of ["keydown", "keyup", "pointermove", "pointerdown"]) {
    window.addEventListener(type, updateModifier);
  }
  window.addEventListener("blur", () => skinRoot.removeAttribute("data-adjust-modifier"));
}
const root = document.getElementById("channels");
const systemMenu = document.getElementById("system-menu");
const addChannel = document.getElementById("add-channel");
const channelList = document.getElementById("channel-list");
const transport = document.getElementById("transport");
let transportPlaying = null;
let audioRunning = null;
let desiredLoudness = false;
let meterSubscription = null;
const performance = document.getElementById("performance");
const settings = document.getElementById("settings");

const audioStatus = document.getElementById("audio-status");
const status = document.getElementById("status");
const toolbar = document.getElementById("toolbar");
const dragArea = document.getElementById("window-drag");

if (nativeFrame) document.getElementById("xair-sidebar-status").append(dragArea);
const minimize = document.getElementById("window-minimize");
const maximize = document.getElementById("window-maximize");
const closeWindow = document.getElementById("window-close");
const rows = new Map();
const studioNavigation = document.getElementById("studio-channel-nav");
if (hud) hud.bindHudChannelNav(studioNavigation);
const studioHeading = document.getElementById("studio-channel-heading");
const studioEmpty = document.getElementById("studio-empty");
let studioSelection = null;
const xairRouting = document.getElementById("xair-routing");
const xairRoutingTitle = document.getElementById("xair-routing-title");
const xairSelectionNumber = document.getElementById("xair-selection-number");
const xairSelectionName = document.getElementById("xair-selection-name");
const xairEmpty = document.getElementById("xair-empty");
const xairActions = [...(document.querySelectorAll?.("[data-mixer-action]") ?? [])];
let xairSelection = null;
let xairChannelDigits = "";
let xairLastDigit = -Infinity;
let draggedEffect = null;

let draggedChannel = null;
let draggedSend = null;
let sendDropHover = null;
let sendDropTargets = new Map();
let gestureTail = Promise.resolve();
let fxTail = Promise.resolve();
let fxEpoch = 0;
let pageUnavailable = false;
let pageGeneration = 0;
let latencyValues = null;

function primaryPlain(parameter, normalized) {
  const raw = parameter.minimum + Math.pow(Math.max(0, Math.min(1, normalized)), 1 / parameter.skew) * (parameter.maximum - parameter.minimum);
  return Math.max(parameter.minimum, Math.min(parameter.maximum, parameter.minimum + Math.round((raw - parameter.minimum) / parameter.step) * parameter.step));
}
function primaryText(parameter) {
  const places = value => {
    const fraction = Math.abs(value % 1);
    let scale = 1;
    for (let digits = 0; digits < 12; digits++, scale *= 10) {
      const scaled = fraction * scale;
      if ((Math.round(scaled) !== 0 || fraction === 0) && Math.abs(scaled - Math.round(scaled)) < 1e-7) return digits;
    }
    return 12;
  };
  const digits = Math.max(places(parameter.step), places(parameter.minimum), places(parameter.maximum));
  return `${primaryPlain(parameter, parameter.normalized).toFixed(digits)}${parameter.units === "%" ? "" : " "}${parameter.units}`;
}

function sendIdentity(send) {
  return JSON.stringify([send.id ?? null, send.dest, send.output_channel ?? null]);
}
function sendExpected(send, channel) {
  return { id:send.id ?? null, dest:send.dest, output_channel:send.output_channel ?? null, channel:{ chain_uuid:channel.chain_uuid ?? null, source_uuid:channel.source_uuid ?? null } };
}
function channelExpected(channel) {
  return { chain_uuid:channel.chain_uuid ?? null, source_uuid:channel.source_uuid ?? null };
}
function hoverSendDrop(target) {
  if (target === sendDropHover) return;
  sendDropHover?.removeAttribute("data-send-hover");
  sendDropHover = target;
  sendDropHover?.setAttribute("data-send-hover", "");
}
// An ineligible effect row must never fall through to a channel send.
function sendDropElement(node) {
  return node?.closest?.("[data-effect-instance], .channel");
}
function finishSendDrag() {
  if (!draggedSend) return;
  draggedSend = null;
  hoverSendDrop(null);
  for (const element of sendDropTargets.keys()) element.removeAttribute("data-send-target");
  sendDropTargets.clear();
}
function markSendTargets(state) {
  const { source, expected } = draggedSend;
  if (rows.get(source.channel.id) !== source || source.channel.hidden || source.sends.hidden ||
      !sameChannelIdentity(source.channel, expected)) {
    finishSendDrag();
    return;
  }
  const sidechains = new Set(state.sidechains ?? Object.entries(state.effectInfo ?? {})
    .filter(([, info]) => info?.hasSidechain === true).map(([instance]) => Number(instance)));
  const eligible = new Set(channelSendTargets(state.graph, source.channel.id, sidechains).map(target => target.id));
  const next = new Map();
  for (const [id, row] of rows) {
    if (row.channel.hidden) continue;
    const channelTarget = `chain:${id}`;
    if (eligible.has(channelTarget)) next.set(row.item, channelTarget);
    if (row.effects.hidden || row.effects.getAttribute("inert") !== null) continue;
    for (const element of row.effects.children) {
      const instance = element.getAttribute("data-effect-instance");
      if (instance === null || state.missingEffects?.[instance]) continue;
      const effectTarget = `sidechain:${instance}`;
      if (eligible.has(effectTarget)) next.set(element, effectTarget);
    }
  }
  if (!next.has(sendDropHover)) hoverSendDrop(null);
  for (const element of sendDropTargets.keys()) {
    if (!next.has(element)) element.removeAttribute("data-send-target");
  }
  for (const element of next.keys()) {
    if (!sendDropTargets.has(element)) element.setAttribute("data-send-target", "");
  }
  sendDropTargets = next;
}
function channelOrderGuard(channels) {
  return channels.map(channel => [channel.id, channelExpected(channel), Boolean(channel.hidden), Boolean(channel.align_right)]);
}
function effectExpected(channel, effect) {
  return { channel:channelExpected(channel), effect_uuid:effect.effect_uuid ?? null, path:effect.path ?? "", fuid:effect.fuid ?? null, cid:effect.cid ?? null };
}
function effectIdentity(channel, effect) {
  return JSON.stringify(effectExpected(channel, effect));
}

function copyEffectToChannel(source, row, targetEffect) {
  const channel = row.channel;
  const rack = channel.rack ?? [];
  const index = targetEffect ? rack.findIndex(effect => effect.instance === targetEffect.instance) : rack.length;
  if (index < 0 || (targetEffect && effectIdentity(channel, rack[index]) !== effectIdentity(channel, targetEffect))) return;
  host.effect.copyTo(source.channel, source.instance, channel.id, index, source.expectedEffect, channelExpected(channel), structuredClone(rack)).catch(reportError);
}

function droppedEffect(event) {
  const files=event.dataTransfer?.files;
  return files?.length===1 && /\.(?:vst3|fx\.audcore)$/i.test(files[0].name) ? files[0] : null;
}
function droppedAudio(event) {
  const files=event.dataTransfer?.files;
  return files?.length===1 && /\.(?:caf|wav|flac|opus)$/i.test(files[0].name) ? files[0] : null;
}
function insertDroppedEffect(event, row, targetEffect) {
  const file=droppedEffect(event);
  if (!file) return false;
  event.preventDefault();
  const channel=row.channel, rack=channel.rack ?? [];
  const index=targetEffect ? rack.findIndex(effect=>effect.instance===targetEffect.instance) : rack.length;
  if (index<0 || (targetEffect && effectIdentity(channel,rack[index])!==effectIdentity(channel,targetEffect))) return true;
  host.effect.insertDroppedFile(file,channel.id,index,channelExpected(channel),structuredClone(rack)).catch(reportError);
  return true;
}

// Wet and send values cross the host protocol as f32. Compare their encoded
// values so ordinary binary rounding is not mistaken for an external edit.
function samePendingValue(kind, a, b) {
  return kind === "primary" ? Math.abs(a - b) < 1e-9 : Math.fround(a) === Math.fround(b);
}

function sameChannelIdentity(a, b) {
  return (a?.chain_uuid ?? null) === (b?.chain_uuid ?? null) && (a?.source_uuid ?? null) === (b?.source_uuid ?? null);
}

let showingRecordingNotice = false;
let recordingNotice = null;
let recordingLabel = null;
let recordingReveal = null;
let statusError = null;
let noticeLanguage = null;
function errorText(message) {
  if (message === "request timed out: settings.open") {
    return { zh:"打开设置超时，请重试", en:"Opening settings timed out. Try again", ja:"設定を開けませんでした。再試行してください" }[host.i18n.getLanguage()] ?? "Opening settings timed out. Try again";
  }
  if (message === "input context unsupported") {
    return { zh:"当前声核版本不支持输入扩展菜单，请更新声核", en:"Update Audcore to use input extension actions", ja:"入力拡張の操作には声核を更新してください" }[host.i18n.getLanguage()] ?? "Update Audcore to use input extension actions";
  }
  return localizeHostError(message, host.i18n.t);
}
function reportError(error) {
  showingRecordingNotice = false;
  recordingNotice = null;
  recordingLabel = recordingReveal = null;
  statusError = error instanceof Error ? error.message : "操作失败";
  status.textContent = errorText(statusError);
}
const transportControl = createTransportControl(value => host.transport.setPlaying(value), reportError);
function resetFxQueue() { fxEpoch++; fxTail = Promise.resolve(); }
function queueFxEdit(row, id, value) {
  const epoch = fxEpoch;
  const expected = channelExpected(row.channel);
  const task = fxTail.then(() => {
    if (epoch !== fxEpoch || pageUnavailable || document.hidden || rows.get(id) !== row || !sameChannelIdentity(row.channel, expected)) {
      throw new Error("skin session inactive");
    }
    return host.channel.setFxBypass(id, value, expected);
  });
  fxTail = task.catch(() => {});
  return task;
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) return;
  finishSendDrag();
  transportControl.cancel();
  resetFxQueue();
  for (const row of rows.values()) {
    if (row.hud) {
      hud.paintHudMeter(row, 0, "—");
      row.meterLeft.style.transform = row.meterRight.style.transform = "scaleY(0)";
      row.loudnessLeft.style.transform = row.loudnessRight.style.transform = "scaleY(0)";
      row.meter.setAttribute("aria-valuenow", "0");
      row.meter.removeAttribute("aria-valuetext");
    }
    row.pendingToggles.clear();
    row.fxControl.cancel();
    row.pendingEffectValues.clear();
    row.pendingSendValues.clear();
    row.pendingGain = null;
  }
});

function renderRecordingNotice() {
  const notice = recordingNotice;
  if (!notice) return;
  noticeLanguage = document.documentElement.getAttribute("lang");
  if (!recordingLabel || !recordingReveal) {
    recordingLabel = document.createElement("span");
    recordingReveal = document.createElement("button");
    recordingReveal.type = "button";
    recordingReveal.addEventListener("click", () => host.recording.revealSaved(notice.token).catch(reportError));
    status.textContent = "";
    status.append(recordingLabel, recordingReveal);
  }
  recordingLabel.textContent = `${host.i18n.t("录音已保存：")}${notice.name} `;
  recordingReveal.textContent = host.i18n.t("打开文件夹");
  recordingReveal.title = host.i18n.t("打开文件夹并选中录音文件");
}

const disposeNotices = host.notifications?.subscribe(notice => {
  if (notice.level === "recording_expired") {
    if (showingRecordingNotice) status.textContent = "";
    showingRecordingNotice = false;
    recordingNotice = null;
    recordingLabel = recordingReveal = null;
    return;
  }
  showingRecordingNotice = notice.level === "recording_saved";
  recordingNotice = showingRecordingNotice ? notice : null;
  recordingLabel = recordingReveal = null;
  if (!showingRecordingNotice) { statusError = notice.message; status.textContent = localizeHostError(statusError, host.i18n.t); return; }
  statusError = null;
  renderRecordingNotice();
});
if (!nativeFrame) {
  bindWindowControls({ toolbar, drag: dragArea, minimize, maximize, close: closeWindow,
    channels: root, resizeAreas: document.querySelectorAll?.("[data-resize]") ?? [],
    api: host.window, onError: reportError });
}

systemMenu.addEventListener("click", event => {
  const rect = event.currentTarget.getBoundingClientRect();
  host.menu.openSystem({ x: rect.left, y: rect.bottom }).catch(reportError);
});
transport.addEventListener("click", () => {
  transportControl.toggle();
});
transport.addEventListener("contextmenu", event => {
  event.preventDefault();
  const rect = transport.getBoundingClientRect();
  const anchor = event.clientX === 0 && event.clientY === 0 ? { x:rect.left, y:rect.bottom } : { x:event.clientX, y:event.clientY };
  host.menu.openTransport(anchor).catch(reportError);
});
addChannel.addEventListener("click", () => {
  const rect = addChannel.getBoundingClientRect();
  host.menu.openAddChannel({ x: rect.left, y: rect.bottom }).catch(reportError);
});
channelList?.addEventListener("click", () => {
  const rect = channelList.getBoundingClientRect();
  host.menu.openChannelList({ x: rect.left, y: rect.bottom }).catch(reportError);
});
// Match the native mixer: the upper channel area scrolls horizontally;
// the control area remains available for gain and other gestures.
root.addEventListener("wheel", event => {
  if (event.defaultPrevented || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
  if (!event.shiftKey) {
    if (event.target?.closest?.(".controls")) return;
    const rack = event.target?.closest?.(".effects, .sends");
    if (rack && rack.scrollHeight > rack.clientHeight && getComputedStyle(rack).overflowY === "auto") return;
  }
  const viewport = root.parentElement;
  if (!viewport || viewport.scrollWidth <= viewport.clientWidth) return;

  if (studioSkin && !event.shiftKey && viewport.scrollHeight > viewport.clientHeight) return;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
  const before = viewport.scrollLeft;
  viewport.scrollLeft += event.deltaY * unit;
  if (viewport.scrollLeft !== before) event.preventDefault();
}, { passive: false });
root.addEventListener("contextmenu", event => {
  if (event.target !== root) return;
  event.preventDefault();
  const rect = root.getBoundingClientRect();
  const anchor = event.clientX === 0 && event.clientY === 0 ? { x:rect.left, y:rect.bottom } : { x:event.clientX, y:event.clientY };
  host.menu.openChannelList(anchor).catch(reportError);
});
root.setAttribute("data-audcore-file-drop","audio");
if (hasSendDrag) {
  root.addEventListener("dragleave", event => {
    if (draggedSend && sendDropElement(event.relatedTarget) !== sendDropHover) hoverSendDrop(null);
  });
}
root.addEventListener("dragover",event=>{
  if (draggedSend) {
    const target = sendDropElement(event.target);
    const available = sendDropTargets.has(target);
    hoverSendDrop(available ? target : null);
    if (event.dataTransfer) event.dataTransfer.dropEffect = available ? "link" : "none";
    if (available) event.preventDefault();
    return;
  }
  if (event.target!==root || !Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
  event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect="copy";
});
root.addEventListener("drop",event=>{
  if (draggedSend) {
    event.preventDefault();
    const target = sendDropElement(event.target);
    const targetId = sendDropTargets.get(target);
    const { source, expected } = draggedSend;
    finishSendDrag();
    if (targetId) host.channel.addSend(source.channel.id, targetId, expected).catch(reportError);
    return;
  }
  if(event.target!==root)return;
  const file=droppedAudio(event);if(!file)return;
  event.preventDefault();host.audio.dropFile(file,null).catch(reportError);
});
performance?.addEventListener("click", () => { host.performance.open().catch(reportError); });
settings.addEventListener("click", () => { host.settings.open().catch(reportError); });
if (xairSkin) {
  for (const action of ["save", "open"]) {
    document.getElementById(`xair-${action}`).addEventListener("click", () => host.document[action]().catch(reportError));
  }
  for (const element of xairActions) {
    const action = element.getAttribute("data-mixer-action");
    element.addEventListener("click", () => {
      if (action === "mixer" || action === "meters") {
        skinRoot.setAttribute("data-xair-view", action);
        for (const control of xairActions) {
          if (control.getAttribute("aria-pressed") !== null) control.setAttribute("aria-pressed", String(control === element));
        }
        return;
      }
      const row = xairSelection;
      if (!row || row.item.hidden) return;
      if (action === "solo") {
        const rect = element.getBoundingClientRect();
        host.menu.openSolo(row.channel.id, { x: rect.left, y: rect.bottom }, channelExpected(row.channel)).catch(reportError);
        return;
      }
      const target = { channel: row.name, input: row.input, effects: row.addEffect, sends: row.addSend }[action];
      if (!target) return;
      target.focus();
      target.click();
    });
  }
}
document.addEventListener("keydown", event => {
  // New hosts consume this key before delivery to WebView. Older hosts and the preview receive it here.
  if (!performance && !event.defaultPrevented && event.code === "Backquote" &&
      !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
    event.preventDefault();
    if (!event.repeat) host.performance.open().catch(reportError);
    return;
  }
  const target = event.target;
  const tag = target?.tagName?.toLowerCase();
  const editing = target?.isContentEditable || tag === "textarea" || tag === "select" ||
    (tag === "input" && !["range", "checkbox", "radio", "button", "submit"].includes(target.type));
  if (xairSkin && !event.defaultPrevented && !editing && !event.ctrlKey && !event.altKey &&
      !event.metaKey && !event.shiftKey && !event.repeat && !event.isComposing && /^[0-9]$/.test(event.key)) {
    const now = event.timeStamp;
    const digits = now - xairLastDigit < 450 ? xairChannelDigits + event.key : event.key;
    const candidates = [...rows.values()].filter(row => !row.item.hidden);
    const match = number => candidates.find(row => Number(row.index.textContent) === number);
    const sequence = digits !== event.key && candidates.some(row => String(Number(row.index.textContent)).startsWith(digits));
    xairChannelDigits = sequence ? digits : event.key;
    xairLastDigit = now;
    const row = sequence ? match(Number(digits)) : match(Number(event.key) || 10);
    if (row) {
      event.preventDefault();
      focusXairChannel(row);
    }
    return;
  }
  if (!event.ctrlKey || event.altKey || event.metaKey || event.isComposing || editing) return;
  const key = event.key?.toLowerCase();
  if (key === "z" || key === "y") {
    event.preventDefault();
    const action = key === "y" || event.shiftKey ? "redo" : "undo";
    host.history[action]().catch(reportError);
  } else if (!event.shiftKey && ["n", "o", "s"].includes(key)) {
    event.preventDefault();
    if (event.repeat) return;
    const action = { n: "new", o: "open", s: "save" }[key];
    host.document[action]().catch(reportError);
  } else if (key === "w" || key === "t" || key === "p") {
    event.preventDefault();
    if (event.repeat) return;
    if (key === "w") host.window.close().catch(reportError);
    else if (key === "t") host.channel.add(null).catch(reportError);
    else if (event.shiftKey) {
      const rect = transport.getBoundingClientRect();
      host.menu.openTransport({ x: rect.left, y: rect.bottom }).catch(reportError);
    } else transportControl.toggle();
  }
});

function button(text, title, action) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.title = title;
  element.setAttribute("aria-label", title);
  element.addEventListener("click", action);
  return element;
}

function selectStudioChannel(row) {
  if (studioSelection === row) return;
  studioSelection?.item.removeAttribute("data-selected");
  studioSelection?.jump.removeAttribute("aria-current");
  if (hudSkin && studioSelection) studioSelection.jump.tabIndex = -1;
  studioSelection = row;
  row?.item.setAttribute("data-selected", "");
  if (hudSkin && row) {
    row.jump.tabIndex = 0;
    root.closest("main").scrollTop = 0;
  }
  row?.jump.setAttribute("aria-current", "true");
}

function selectXairChannel(row) {
  if (xairSelection !== row) {
    xairSelection?.item.removeAttribute("data-selected");
    xairSelection?.jump.removeAttribute("aria-current");
    xairSelection = row;
    row?.item.setAttribute("data-selected", "");
    row?.jump.setAttribute("aria-current", "true");
  }
  const number = row?.index.textContent ?? "—";
  const label = row?.name.title ?? "No channel";
  if (xairSelectionNumber.textContent !== number) xairSelectionNumber.textContent = number;
  if (xairSelectionName.textContent !== label) {
    xairSelectionName.textContent = label;
    xairSelectionName.title = label;
  }
  const unavailable = { input: row?.input.hidden, effects: row?.effects.hidden, sends: row?.sends.hidden, solo: row?.solo.hidden };
  for (const control of xairActions) {
    const action = control.getAttribute("data-mixer-action");
    if (action === "mixer" || action === "meters") continue;
    control.disabled = !row || Boolean(unavailable[action]);
  }
}

function focusXairChannel(row) {
  selectXairChannel(row);
  row.name.focus({ preventScroll: true });
  row.item.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function studioSlotGroup(slots, kind, leading, add) {
  const group = document.createElement("div");
  group.className = `studio-slot-group studio-${kind}`;
  const header = document.createElement("div");
  header.className = "studio-slot-header";
  const caption = document.createElement("span");
  if (leading) header.append(leading);
  header.append(caption);
  if (add) header.append(add);
  group.append(header, slots);
  return { group, header, caption };
}

const meterLevel = studioScale?.meterFraction ?? (db => Math.max(0, Math.min(1, (db + 60) / 72)));

function channelNameInk(color) {
  const rgb = [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.179 ? "#000" : "#fff";
}

function createAddSend(getRow, text, label) {
  let moved = false;
  const addSend = button(text, label, event => {
    if (moved && event.detail > 0) { moved = false; return; }
    const row = getRow();
    const rect = addSend.getBoundingClientRect();
    host.menu.openAddSend(row.channel.id, { x: rect.left, y: rect.bottom }, channelExpected(row.channel)).catch(reportError);
  });
  if (hasSendDrag && typeof host.channel.addSend === "function") {
    addSend.setAttribute("draggable", "true");
    addSend.addEventListener("dragstart", event => {
      const row = getRow();
      if (!event.dataTransfer || row.channel.hidden || row.sends.hidden) { event.preventDefault(); return; }
      finishSendDrag();
      draggedSend = { source: row, expected: channelExpected(row.channel) };
      event.dataTransfer.setData("application/x-audcore-send", String(row.channel.id));
      event.dataTransfer.effectAllowed = "link";
      markSendTargets(row.state);
    });
    addSend.addEventListener("dragend", finishSendDrag);
  }
  return addSend;
}

function createChannel(channel) {
  const item = document.createElement("section");
  item.className = "channel";
  item.setAttribute("data-audcore-file-drop","audio");
  item.addEventListener("contextmenu", event => {
    event.preventDefault();
    if (host.menu?.openChannel) {
      const rect = item.getBoundingClientRect();
      const anchor = event.clientX === 0 && event.clientY === 0 ? { x: rect.left, y: rect.bottom } : { x: event.clientX, y: event.clientY };
      host.menu.openChannel(channel.id, anchor, channelExpected(channel)).catch(reportError);
    } else {
      reportError(new Error("当前预览不支持通道菜单"));
    }
  });
  const input = button("", "输入", () => {
    const rect = input.getBoundingClientRect();
    host.menu.openInput(channel.id, { x: rect.left, y: rect.bottom }, channelExpected(channel)).catch(reportError);
  });
  input.className = "input";
  input.addEventListener("contextmenu", event => {
    event.preventDefault();
    event.stopPropagation();
    const rect = input.getBoundingClientRect();
    const anchor = event.clientX === 0 && event.clientY === 0 ? { x:rect.left, y:rect.bottom } : { x:event.clientX, y:event.clientY };
    if (typeof host.menu.openInputContext !== "function") {
      reportError(new Error("input context unsupported"));
      return;
    }
    host.menu.openInputContext(channel.id, anchor, channelExpected(channel)).catch(reportError);
  });
  const effects = document.createElement("div");
  effects.className = "effects";
  const latency = document.createElement("output");
  latency.className = "effect-latency";
  const sends = document.createElement("div");
  sends.className = "sends";
  const addSend = (createAddSend(() => row, "＋", ""));
  if (addSend) sends.append(addSend);
  const controls = document.createElement("div");
  controls.className = "controls";
  const mappedFader = studioScale ?? (xairSkin ? xairFader : null);
  const gain = (document.createElement("input"));
  if (gain) {
    gain.type = "range";
    gain.min = mappedFader ? "0" : "-60";
    gain.max = mappedFader ? String(mappedFader.faderResolution) : "12";
    gain.step = mappedFader ? "1" : "0.1";
    gain.className = "gain";
  }
  const meter = document.createElement("div");
  meter.className = "meter";
  meter.setAttribute("role", "meter");
  meter.setAttribute("aria-valuemin", "0");
  meter.setAttribute("aria-valuemax", "1");
  meter.setAttribute("aria-valuenow", "0");
  const meterLeft = (document.createElement("div"));
  const meterRight = (document.createElement("div"));
  const loudnessLeft = (document.createElement("div"));
  const loudnessRight = (document.createElement("div"));
  {
    meterLeft.className = meterRight.className = "meter-fill";
    loudnessLeft.className = loudnessRight.className = "meter-loudness";
    loudnessLeft.setAttribute("data-side", "left");
    loudnessRight.setAttribute("data-side", "right");
    meter.append(meterLeft, meterRight, loudnessLeft, loudnessRight);
  }
  const values = document.createElement("div");
  values.className = "values";
  const value = document.createElement(numericGain ? "input" : "output");
  value.className = "value";
  let row;
  let gainMax = 12;
  const gainValue = () => mappedFader ? mappedFader.faderGain(Number(gain.value)) : Number(gain.value);
  const gainText = db => Number(db).toFixed(1);
  const showGain = (db, setSlider = true) => {
    if (gain && setSlider) gain.value = String(mappedFader ? mappedFader.faderPosition(db) : db);
    const text = `${Number(db).toFixed(1)} dB`;
    if (mappedFader || numericGain || hudSkin) gain?.setAttribute("aria-valuetext", text);
    if (numericGain) {
      if (document.activeElement !== value) value.value = gainText(db);
    } else {
      value.textContent = studioV2 ? `${Number(Number(db).toFixed(1))}dB` : text;
    }
  };
  const execute = promise => promise.catch(error => {
    reportError(error);
    render(row.state);
  });
  const phase = button(studioV2 ? "◐" : "Ø", "相位", () => row.pendingToggles.toggle("phase", Math.abs(row.channel.phase ?? 0) > 90, value => host.channel.setPhase(channel.id, value ? 180 : 0, channelExpected(row.channel))));
  const fx = button("FX", "效果器旁通", () => row.fxControl.toggle());
  const solo = button("S", "独奏", () => row.pendingToggles.toggle("solo", Boolean(row.channel.solo), value => host.channel.setSolo(channel.id, value, channelExpected(row.channel))));
  solo.addEventListener("contextmenu", event => {
    event.preventDefault();
    event.stopPropagation();
    const rect = solo.getBoundingClientRect();
    const anchor = event.clientX === 0 && event.clientY === 0 ? { x: rect.left, y: rect.bottom } : { x: event.clientX, y: event.clientY };
    host.menu.openSolo(channel.id, anchor, channelExpected(channel)).catch(reportError);
  });
  const recording = button("REC", "录音", () => {
    if (row.channel.recording_stopping) return;
    execute(host.channel.setRecording(channel.id, !row.channel.recording, channelExpected(row.channel)));
  });
  recording.addEventListener("contextmenu", event => {
    event.preventDefault();
    event.stopPropagation();
    const rect = recording.getBoundingClientRect();
    const anchor = event.clientX === 0 && event.clientY === 0 ? { x: rect.left, y: rect.bottom } : { x: event.clientX, y: event.clientY };
    host.menu.openRecording(channel.id, anchor, channelExpected(channel)).catch(reportError);
  });
  const mute = button("M", "静音", () => row.pendingToggles.toggle("muted", Boolean(row.channel.muted), value => host.channel.setMute(channel.id, value, channelExpected(row.channel))));
  const link = button("↔", "通道链接", () => {
    const rect = link.getBoundingClientRect();
    (host.menu.openLinkSettings ?? host.menu.openLink)(channel.id, { x: rect.left, y: rect.bottom }, channelExpected(channel)).catch(reportError);
  });
  link.addEventListener("contextmenu", event => {
    event.preventDefault();
    event.stopPropagation();
    const rect = link.getBoundingClientRect();
    const anchor = event.clientX === 0 && event.clientY === 0 ? { x: rect.left, y: rect.bottom } : { x: event.clientX, y: event.clientY };
    host.menu.openLink(channel.id, anchor, channelExpected(channel)).catch(reportError);
  });
  // The host owns shortcut capture. Older hosts retain the channel-menu path.
  const shortcut = button("⌨", "全局快捷键", () => {
    const rect = shortcut.getBoundingClientRect();
    (host.menu.openShortcut ?? host.menu.openChannel)(channel.id, { x:rect.left, y:rect.bottom }, channelExpected(row.channel)).catch(reportError);
  });
  const overload = button("—", "清除超限提示", () => {
    row.overloadPeak = null;
    overload.textContent = "—";
    overload.disabled = true;
    overload.setAttribute("data-overload", "false");
  });
  overload.disabled = true;
  overload.setAttribute("data-overload", "false");
  for (const [element, name] of [[value, "value"], [phase, "phase"], [fx, "fx"], [solo, "solo"], [recording, "recording"], [mute, "mute"], [link, "link"], [overload, "overload"], [shortcut, "shortcut"]]) {
    element.setAttribute("data-control", name);
  }
  let gainGesture = null;
  const beginGainGesture = event => {
    if (event.button !== 0 || gainGesture) return;
    row.pendingGain = null;
    const gesture = { pointer: event.pointerId, ready: false, finished: false, commit: false, value: null, expectedChannel:channelExpected(row.channel) };
    gainGesture = gesture;
    const previous = gestureTail;
    const generation = pageGeneration;
    let release;
    gestureTail = new Promise(resolve => { release = resolve; });
    const endEdit = () => host.history.endEdit().catch(reportError).finally(release);
    const cleanup = commit => {
      if (gesture.finished) return;
      gesture.finished = true;
      gesture.commit = commit;
      if (gainGesture === gesture) gainGesture = null;
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", loseFocus);
      window.removeEventListener("pagehide", loseFocus);
      document.removeEventListener("visibilitychange", visibility);
      if (!commit && !gesture.ready) {
        showGain(row.channel.gainDb ?? 0);

      }
      if (gesture.ready) endEdit();
    };
    const finish = event => { if (event.pointerId === gesture.pointer) cleanup(true); };
    const cancel = event => { if (event.pointerId === gesture.pointer) cleanup(false); };
    const loseFocus = () => cleanup(false);
    const visibility = () => { if (document.hidden) cleanup(false); };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", loseFocus);
    window.addEventListener("pagehide", loseFocus);
    document.addEventListener("visibilitychange", visibility);
    previous.then(() => {
      if (pageUnavailable || generation !== pageGeneration || document.hidden || rows.get(channel.id) !== row || (gesture.finished && !gesture.commit)) { release(); return; }
      return host.history.beginEdit().then(() => {
        gesture.ready = true;
        if (!pageUnavailable && generation === pageGeneration && !document.hidden && rows.get(channel.id) === row && (!gesture.finished || gesture.commit) && gesture.value !== null) {
          execute(host.channel.setGain(channel.id, gesture.value, gesture.expectedChannel));
        }
        if (gesture.finished) endEdit();
      }).catch(error => {
        cleanup(false);
        release();
        showGain(row.channel.gainDb ?? 0);

        reportError(error);
      });
    });
    return gesture;
  };
  gain?.addEventListener("pointerdown", beginGainGesture);
  const requestGain = db => {
    const actual = Number(row.channel.gainDb ?? 0);
    const pending = row.pendingGain;
    const base = pending?.value ?? actual;
    if (Math.abs(db - base) < 1e-9) return;
    const request = { value: db, observed: pending?.observed ?? actual, sent: [...(pending?.sent ?? []), db].slice(-256) };
    row.pendingGain = request;
    if (numericGain || studioV2) showGain(db);
    host.channel.setGain(channel.id, db, channelExpected(row.channel)).catch(error => {
      if (row.pendingGain !== request) return;
      row.pendingGain = null;
      if (numericGain || studioV2) showGain(row.channel.gainDb ?? 0);
      reportError(error);
    });
  };
  const adjustGain = step => {
    const base = row.pendingGain?.value ?? Number(row.channel.gainDb ?? 0);
    requestGain(Math.max(-60, Math.min(gainMax, Math.round((base + step) * 10) / 10)));
  };
  gain?.addEventListener("wheel", event => {
    if (rows.get(channel.id) !== row || gainGesture || event.shiftKey || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    event.preventDefault();
    const step = event.ctrlKey ? 1 : 0.1;
    adjustGain(event.deltaY < 0 ? step : -step);
  }, { passive: false });
  gain?.addEventListener("dblclick", event => {
    if (event.button !== 0 || rows.get(channel.id) !== row) return;
    event.preventDefault();
    row.pendingGain = null;
    const generation = pageGeneration;
    const expected = channelExpected(row.channel);
    gestureTail = gestureTail.then(async () => {
      if (pageUnavailable || generation !== pageGeneration || document.hidden || rows.get(channel.id) !== row || !sameChannelIdentity(row.channel, channel)) return;
      await host.channel.setGain(channel.id, 0, expected);
    }).catch(reportError);
  });
  gain?.addEventListener("input", () => {
    if (rows.get(channel.id) !== row) return;
    row.pendingGain = null;
    const db = Math.min(gainMax, gainValue());
    showGain(db, Boolean(mappedFader));
    if (gainGesture && !gainGesture.ready) gainGesture.value = db;
    else execute(host.channel.setGain(channel.id, db, gainGesture?.expectedChannel ?? channelExpected(row.channel)));
  });
  values.append(value, phase, fx, solo, recording, mute, link, overload, shortcut);
  if (gain) controls.append(gain, meter, values);
  let suppressNameClick = false;
  const name = hasChannelSettingsButton ? button("", "", event => {
    if (suppressNameClick && event.detail > 0) {
      suppressNameClick = false;
      return;
    }
    const { id } = row.channel;
    const expected = channelExpected(row.channel);
    const openMenu = () => {
      const rect = name.getBoundingClientRect();
      return host.menu.openChannel(id, { x: rect.left, y: rect.bottom }, expected);
    };
    const openSettings = host.menu.openChannelSettings;
    (openSettings ? openSettings(id, expected).catch(error => {
      if (error.message !== "unsupported method") throw error;
      return openMenu();
    }) : openMenu()).catch(reportError);
  }) : document.createElement("div");
  name.className = "name";
  const pointerChannelOrder = (xairSkin);
  if (!pointerChannelOrder) name.setAttribute("draggable", "true");
  name.setAttribute("aria-keyshortcuts", "Alt+ArrowLeft Alt+ArrowRight");
  name.tabIndex = 0;
  const canDropChannel = target => target && target !== row && !target.channel.hidden &&
    ((Boolean(target.channel.align_right) === Boolean(row.channel.align_right)));
  const moveChannel = (source, target, expected) => {
    const channels = row.state?.channels ?? [];
    const ids = channels.map(item => item.id);
    const guard = channelOrderGuard(channels);
    if (expected && JSON.stringify(guard) !== JSON.stringify(expected)) return;
    const from = ids.indexOf(source);
    const to = ids.indexOf(target);
    if (from < 0 || to < 0 || from === to || channels[from].hidden || channels[to].hidden ||
        ((Boolean(channels[from].align_right) !== Boolean(channels[to].align_right)))) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    host.channel.setOrder(ids, guard).catch(reportError);
  };
  if (pointerChannelOrder) {
    item.setAttribute("data-channel-order-id", String(channel.id));
    let drag;
    let dropTarget;
    const targetAt = event => {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-channel-order-id]");
      const targetRow = target && rows.get(Number(target.getAttribute("data-channel-order-id")));
      return targetRow?.item === target && canDropChannel(targetRow) ? targetRow : null;
    };
    name.addEventListener("pointerdown", event => {
      if (event.button !== 0 || drag || row.channel.hidden) return;
      suppressNameClick = false;
      drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, order: channelOrderGuard(row.state.channels) };
      name.setPointerCapture(event.pointerId);
    });
    name.addEventListener("pointermove", event => {
      if (event.pointerId !== drag?.pointer) return;
      if (!suppressNameClick && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
      suppressNameClick = true;
      name.setAttribute("data-dragging", "");
      const target = targetAt(event);
      if (target !== dropTarget) {
        dropTarget?.item.removeAttribute("data-channel-drop-target");
        target?.item.setAttribute("data-channel-drop-target", "");
        dropTarget = target;
      }
    });
    const finishDrag = event => {
      if (event.pointerId !== drag?.pointer) return;
      const { order } = drag;
      drag = null;
      name.removeAttribute("data-dragging");
      dropTarget?.item.removeAttribute("data-channel-drop-target");
      dropTarget = null;
      if (event.type !== "pointerup") {
        suppressNameClick = false;
        return;
      }
      const target = suppressNameClick ? targetAt(event) : null;
      if (target && rows.get(channel.id) === row) moveChannel(channel.id, target.channel.id, order);
    };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) name.addEventListener(type, finishDrag);
  } else {
    name.addEventListener("dragstart", event => {
      const channels = row.state?.channels ?? [];
      if (row.channel.hidden || !channels.some(item => item.id === channel.id)) { event.preventDefault(); return; }
      draggedChannel = { id: channel.id, order: channelOrderGuard(channels), right: Boolean(row.channel.align_right) };
      name.setAttribute("data-dragging", "");
      event.dataTransfer?.setData("text/plain", String(channel.id));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    name.addEventListener("dragend", () => {
      name.removeAttribute("data-dragging");
      draggedChannel = null;
    });
  }
  item.addEventListener("dragover", event => {
    if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) {event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect="copy";return;}
    if (!draggedChannel || draggedChannel.id === channel.id || row.channel.hidden || draggedChannel.right !== Boolean(row.channel.align_right)) return;
    event.preventDefault();
  });
  item.addEventListener("drop", event => {
    const file=droppedAudio(event);
    if(file){
      event.preventDefault();event.stopPropagation();
      if(rows.get(channel.id)===row && sameChannelIdentity(row.channel,channel)) host.audio.dropFile(file,row.channel.id,channelExpected(row.channel)).catch(reportError);
      return;
    }
    if (!draggedChannel) return;
    event.preventDefault();
    const drag = draggedChannel;
    draggedChannel = null;
    moveChannel(drag.id, channel.id, drag.order);
  });
  name.addEventListener("keydown", event => {
    if (!event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const visible = (row.state?.channels ?? []).filter(item => !item.hidden &&
      ((Boolean(item.align_right) === Boolean(row.channel.align_right))));
    const index = visible.findIndex(item => item.id === channel.id);
    const target = visible[index + (event.key === "ArrowLeft" ? -1 : 1)];
    if (index < 0 || !target) return;
    event.preventDefault();
    moveChannel(channel.id, target.id);
  });
  row = { item, input, effects, latency, sends, addSend, gain, meter, meterLeft, meterRight, loudnessLeft, loudnessRight, value, phase, fx, solo, recording, mute, link, shortcut, overload, overloadPeak: null, name, channel, state: null, signature: "", pendingEffectValues: new Map(), pendingSendValues: new Map(), pendingGain: null, pendingToggles: createPendingToggles(reportError), fxControl: createTransportControl(value => queueFxEdit(row, channel.id, value), reportError),
    setGainLimit(limit) {
      gainMax = limit;
      if (gain && !mappedFader) gain.max = String(limit);
    },
    syncGain() {

      const keepSlider = document.activeElement === gain && (!mappedFader || gainGesture);
      const db = keepSlider ? gainValue() : ((numericGain || studioV2) ? row.pendingGain?.value : null) ?? row.channel.gainDb ?? 0;
      showGain(studioV2 ? Math.min(gainMax, db) : db, !keepSlider || (studioV2 && db > gainMax));
    },
  };
  if (numericGain) {
    value.type = "text";
    value.inputMode = "decimal";
    let initialValue = "";
    value.addEventListener("focus", () => { initialValue = value.value; value.select(); });
    value.addEventListener("keydown", event => {
      if (event.key === "Escape") value.value = initialValue;
      else if (event.key !== "Enter") return;
      event.preventDefault();
      value.blur();
    });
    value.addEventListener("blur", () => {
      const db = row.pendingGain?.value ?? row.channel.gainDb ?? 0;
      const parsed = xairFader.parseFaderGain(value.value, gainMax);
      if (value.value !== initialValue && parsed !== null && rows.get(channel.id) === row) requestGain(parsed);
      value.value = gainText(row.pendingGain?.value ?? db);
    });

  }
  if (xairSkin) {
    const utility = document.createElement("div");
    utility.className = "xair-utility";
    utility.append(phase, link);
    const monitor = document.createElement("div");
    monitor.className = "xair-monitor";
    monitor.append(recording, overload);
    const fader = document.createElement("div");
    fader.className = "xair-fader";
    const scale = document.createElement("div");
    scale.className = "xair-scale";
    scale.setAttribute("aria-hidden", "true");
    for (const { db, offset } of xairFader.faderMarks) {
      const mark = document.createElement("span");
      if (db !== undefined) mark.textContent = String(db).replace("-", "−");
      mark.style.setProperty("--offset", `${offset * 100}%`);
      scale.append(mark);
    }
    fader.append(scale, gain, meter);
    const slotBox = (kind, list, action, caption) => {
      const group = document.createElement("div");
      group.className = `xair-box xair-${kind}`;
      const header = document.createElement("header");
      header.append(caption);
      if (action) header.append(action);
      group.append(header, list);
      item.append(group);
      return header;
    };
    row.effectHeader = slotBox("effects", effects, null, fx);
    const sendCaption = document.createElement("span");
    sendCaption.textContent = "⇉";
    sendCaption.setAttribute("aria-hidden", "true");
    slotBox("sends", sends, addSend, sendCaption);
    row.index = document.createElement("span");
    row.index.className = "xair-index";
    solo.textContent = "Solo";
    mute.textContent = "Mute";
    value.className = "xair-db";
    gain.addEventListener("keydown", event => {
      const step = { ArrowUp: .1, ArrowRight: .1, ArrowDown: -.1, ArrowLeft: -.1, PageUp: 3, PageDown: -3 }[event.key];
      if (step !== undefined) adjustGain(step);
      else if (event.key === "Home") requestGain(-60);
      else if (event.key === "End") requestGain(gainMax);
      else return;
      event.preventDefault();
    });
    item.insertBefore(utility, item.children[0]);
    item.insertBefore(input, utility);
    item.append(name, solo, value, fader, monitor, mute, row.index);
    row.jump = button("", "", () => focusXairChannel(row));
    row.jump.className = "xair-route";
    item.addEventListener("focusin", () => selectXairChannel(row));
    item.addEventListener("pointerdown", () => selectXairChannel(row));
  } else if (studioSkin) {
    fx.textContent = "⏻";
    row.insertSection = studioSlotGroup(effects, "inserts", fx);
    row.sendSection = studioSlotGroup(sends, "sends", null, addSend);
    row.output = button("", "", () => {
      const current = row.channel;
      const rect = row.output.getBoundingClientRect();
      const anchor = { x: rect.left, y: rect.bottom };
      const send = current.sends?.[0];
      const operation = send
        ? host.menu.openSend(current.id, 0, anchor, sendExpected(send, current))
        : host.menu.openAddSend(current.id, anchor, channelExpected(current));
      operation.catch(reportError);
    });
    row.output.className = "studio-output";
    const scale = document.createElement("div");
    scale.className = "studio-meter-scale";
    scale.setAttribute("aria-hidden", "true");
    const marks = studioScale?.meterMarks ?? [6, 0, -6, -12, -24, -36, -48, -60].map(db => [db]);
    for (const [db, y] of marks) {
      const mark = document.createElement("span");
      mark.textContent = String(db);
      mark.style.setProperty("--meter-level", `${meterLevel(db) * 100}%`);
      if (studioV2) mark.style.setProperty("--studio-tick-y", `${y - 380}px`);
      scale.append(mark);
    }
    const toggles = document.createElement("div");
    toggles.className = "studio-toggles";
    toggles.append(mute, solo, phase, recording);
    const readout = document.createElement("div");
    readout.className = "studio-readout";
    row.mode = document.createElement("span");
    row.mode.className = "studio-mode";
    row.mode.setAttribute("role", "img");
    readout.append(value, row.mode);
    values.replaceChildren(link, shortcut);
    controls.replaceChildren(readout, toggles, scale, meter, gain, overload, values);
    item.append(row.insertSection.group, row.sendSection.group, input, row.output, controls, name);
    if (studioV2) {
      row.index = document.createElement("span");
      row.index.className = "studio-v2-index";
      row.peak = document.createElement("output");
      row.peak.className = "studio-v2-peak";
      row.peak.setAttribute("aria-hidden", "true");
      const track = document.createElement("div");
      track.className = "studio-v2-fader-track";
      track.setAttribute("aria-hidden", "true");
      controls.append(track, row.peak, row.index, latency);
      gain.addEventListener("keydown", event => {
        const step = { ArrowUp: .1, ArrowRight: .1, ArrowDown: -.1, ArrowLeft: -.1, PageUp: 3, PageDown: -3 }[event.key];
        if (step !== undefined) adjustGain(step);
        else if (event.key === "Home") requestGain(-60);
        else if (event.key === "End") requestGain(gainMax);
        else return;
        event.preventDefault();
      });
    }
    row.jump = button("", "", () => {
      selectStudioChannel(row);
      if (hudSkin) return;
      name.focus({ preventScroll: true });
      item.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    row.jump.className = "studio-channel-jump";
    row.jumpLabel = document.createElement("span");
    row.jump.append(row.jumpLabel);
    if (hud) row.hud = hud.arrangeHudChannel(row, controls, readout, toggles);
    item.addEventListener("focusin", () => selectStudioChannel(row));
    item.addEventListener("pointerdown", () => selectStudioChannel(row));
  } else {
    item.append(input, effects, sends, controls, name);
  }
  row.fxControl.update(Boolean(channel.fxBypass), true);
  return row;
}

function render(state, event = null) {
  if (event?.type === "snapshot")
  if (event?.type === "snapshot") { draggedChannel = null; finishSendDrag(); resetFxQueue(); }




  const previousLatencies = latencyValues;
  if (!latencyValues || latencyNeedsUpdate(event)) {
    const calculate = createLatencyCalculator(state.graph, state.effectInfo, state.latencyPolicy?.keepBypassLatency);
    latencyValues = new Map((state.channels ?? []).map(channel => [channel.id, calculate(channel.id)]));
  }
  // Only these fields affect one row. Structural, translated and routing
  // changes still run the complete layout and dependency update.
  const localFields = new Set(["muted", "solo", "solo_safe", "recording", "recording_stopping", "recording_tap", "gainDb", "phase", "fxBypass", "sends"]);
  const previousRack = event?.type === "channel" && event.field === "rack" && event.graphField === "rack"
    ? rows.get(event.id)?.channel?.rack : null;
  const currentRack = previousRack && (state.channels ?? []).find(channel => channel.id === event.id)?.rack;
  // Other channels can label a sidechain from this rack. Only changes that
  // preserve effect identity and labels are safe to paint locally.
  const localRack = Array.isArray(previousRack) && Array.isArray(currentRack) && previousRack.length === currentRack.length &&
    previousRack.every((effect, index) => effect.instance === currentRack[index]?.instance &&
      effect.alias === currentRack[index]?.alias && effect.name === currentRack[index]?.name);

  const affected = event?.type === "channel" && (localFields.has(event.field) || localRack) ? new Set([event.id]) :
    event?.type === "channel_batch" ? new Set(event.changes.map(change => change.id)) :
    event?.type === "primary" ? new Set((state.channels ?? []).filter(channel =>
      (channel.rack ?? []).some(effect => effect.instance === event.instance)).map(channel => channel.id)) : null;
  if (affected && previousLatencies && previousLatencies !== latencyValues) {
    for (const [id, delay] of latencyValues) {
      const previous = previousLatencies.get(id);
      if (delay.total !== previous?.total || delay.mismatch !== previous?.mismatch || delay.ignored !== previous?.ignored) affected.add(id);
    }
  }
  const t = host.i18n.t;
  const previewLabel = preview && channelList ? t("skin.mock_data") : "";
  dragArea.textContent = [previewLabel, state.document?.name].filter(Boolean).join(" · ");
  dragArea.title = dragArea.textContent;
  const audio = state.audio;
  const loudness = state.meterOptions?.loudness === true;
  if (desiredLoudness !== loudness) {
    desiredLoudness = loudness;
    // Old samples belong to the previous subscription demand. Do not show
    // them again while waiting for fresh loudness from the host.
    for (const row of rows.values()) {
      {
        row.loudnessLeft.style.transform = "scaleY(0)";
        row.loudnessRight.style.transform = "scaleY(0)";
      }
    }
    meterSubscription?.setLoudness(loudness);
  } else if (event?.type === "snapshot") meterSubscription?.setLoudness(loudness);
  audioRunning = typeof audio?.running === "boolean" ? audio.running : null;
  if (audioRunning === false) {
    for (const row of rows.values()) {
      if (row.hud) hud.paintHudMeter(row, 0, "—");
      row.meterLeft.style.transform = "scaleY(0)";
      row.meterRight.style.transform = "scaleY(0)";
      row.loudnessLeft.style.transform = "scaleY(0)";
      row.loudnessRight.style.transform = "scaleY(0)";
      row.meter.setAttribute("aria-valuenow", "0");
      row.meter.removeAttribute("aria-valuetext");
      if (row.peak) row.peak.textContent = "";
    }
  }
  audioStatus.textContent = !audio ? "" : !audio.running ? t("音频未运行") :
    `${(audio.sampleRate / 1000).toFixed(1)} kHz · ${audio.bufferFrames}f · ${Number.isFinite(audio.latencyMs) ? audio.latencyMs.toFixed(1) : "—"} ms`;
  audioStatus.title = audioStatus.textContent;
  transportPlaying = typeof state.transport?.playing === "boolean" ? state.transport.playing : null;
  if (event?.type === "snapshot" || (event?.type === "change" && event.key === "transport") ||
      (event?.type === "patch" && Object.hasOwn(event.changes ?? {}, "transport"))) {
    transportControl.update(transportPlaying, event.type === "snapshot");
  }
  transport.disabled = transportPlaying === null;
  transport.textContent = transportPlaying ? "Ⅱ" : "▶";
  transport.title = t(transportPlaying ? "暂停虚拟播放" : "虚拟播放");
  transport.setAttribute("aria-label", transport.title);
  transport.setAttribute("aria-pressed", String(transportPlaying === true));
  systemMenu.setAttribute("aria-label", t("工程菜单"));
  addChannel.setAttribute("aria-label", t("新建通道"));
  if (channelList) {
    channelList.title = t("通道");
    channelList.setAttribute("aria-label", channelList.title);
  }
  if (performance) performance.textContent = t("性能");
  settings.textContent = t("设置");
  for (const [element, label] of [[minimize, "最小化"], [maximize, "最大化"], [closeWindow, "关闭窗口"]]) {
    element.title = t(label);
    element.setAttribute("aria-label", t(label));
  }
  if (state.i18n?.language) {
    document.documentElement.setAttribute("lang", state.i18n.language);
    if (statusError !== null) status.textContent = errorText(statusError);
    else if (recordingNotice && noticeLanguage !== state.i18n.language) renderRecordingNotice();
  }
  if (state.appearance) {
    document.documentElement.setAttribute("data-theme", state.appearance.theme);
    if (!xairSkin) skinRoot.style.zoom = String(state.appearance.scale);
  }
  const seen = new Set();
  let position = 0;
  let firstStudioChannel = null;
  const pinnedOutput = (studioSkin || xairSkin) && state.channels?.findLast(channel => channel.align_right && !channel.hidden);
  let firstRight = true;
  for (const channel of state.channels ?? []) {
    seen.add(channel.id);
    let row = rows.get(channel.id);
    if (row && !sameChannelIdentity(row.channel, channel)) {
      row.pendingToggles.clear();
      row.fxControl.cancel();
      row.pendingEffectValues.clear();
      row.pendingSendValues.clear();
      row.pendingGain = null;
      row.item.remove();
      row.jump?.remove();
      rows.delete(channel.id);
      row = null;
    }
    if (!row) {
      row = createChannel(channel);
      rows.set(channel.id, row);
      root.append(row.item);
    }
    if (root.children[position] !== row.item) root.insertBefore(row.item, root.children[position] ?? null);
    if (studioSkin) {
      if (studioNavigation.children[position] !== row.jump) {
        studioNavigation.insertBefore(row.jump, studioNavigation.children[position] ?? null);
      }
      row.jump.hidden = Boolean(channel.hidden);
      if (!channel.hidden) firstStudioChannel ??= row;
      row.item.toggleAttribute("data-studio-pinned", channel === pinnedOutput);
    }
    if (xairSkin) {
      row.item.toggleAttribute("data-xair-pinned", channel === pinnedOutput);
      row.jump.toggleAttribute("data-pinned", channel === pinnedOutput);
    }
    position += 1;
    row.state = state;
    row.channel = channel;
    const delay = latencyValues.get(channel.id) ?? { total:"", mismatch:"", ignored:false, severe:false };
    const delayText = [delay.total, delay.mismatch].filter(Boolean).join(" ");
    if (row.latency.textContent !== delayText) row.latency.textContent = delayText;
    if (row.latency.getAttribute("data-ignored") !== String(delay.ignored)) row.latency.setAttribute("data-ignored", String(delay.ignored));
    if (row.latency.getAttribute("data-severe") !== String(delay.severe)) row.latency.setAttribute("data-severe", String(delay.severe));
    const visibility = state.channelControls;
    row.setGainLimit(visibility?.gainLimit ? 0 : 12);
    if ((visibility && !xairSkin)) {
      for (const [key, element] of [["input", row.input], ["sends", row.sends], ["effects", row.effects], ["phase", row.phase], ["fx", row.fx], ["solo", row.solo], ["recording", row.recording]]) {
        if (studioSkin && (element === row.phase || element === row.solo || element === row.recording)) continue;
        element.hidden = visibility[key] === false;
      }
    }
    // A snapshot supersedes requests discarded while the skin was suspended.
    if (event?.type === "snapshot") {
      row.pendingEffectValues.clear();
      row.pendingSendValues.clear();
      row.pendingGain = null;
      row.pendingToggles.clear();
    }
    row.fxControl.update(Boolean(channel.fxBypass), event?.type === "snapshot");
    if ((affected) && !affected.has(channel.id)) {
      if (channel.align_right && !channel.hidden) firstRight = false;
      continue;
    }
    for (const key of ["muted", "solo", "phase"]) {
      const explicit = event?.type === "channel" && event.id === channel.id && event.field === key ||
        event?.type === "channel_batch" && event.changes?.some(change => change.id === channel.id && Object.hasOwn(change.fields ?? {}, key));
      row.pendingToggles.update(key, key === "phase" ? Math.abs(channel.phase ?? 0) > 90 : Boolean(channel[key]), explicit);
    }
    if (row.pendingGain) {
      const pending = row.pendingGain;
      const actual = Number(channel.gainDb ?? 0);
      if (samePendingValue("send", actual, pending.value)) row.pendingGain = null;
      else if (!samePendingValue("send", actual, pending.observed)) {
        if (!pending.sent.some(value => samePendingValue("send", actual, value))) row.pendingGain = null;
        else pending.observed = actual;
      }
    }
    for (const [instance, pending] of row.pendingEffectValues) {
      const effect = (channel.rack ?? []).find(item => item.instance === instance);
      const parameter = state.primary?.[instance];
      const actual = pending.kind === "primary" && parameter?.id === pending.parameter ? parameter.normalized : pending.kind === "wet" && !parameter ? (effect?.wet ?? 1) : null;
      if (!effect || pending.identity !== effectIdentity(channel, effect) || actual === null || samePendingValue(pending.kind, actual, pending.value)) row.pendingEffectValues.delete(instance);
      else if (!samePendingValue(pending.kind, actual, pending.observed)) {
        if (!pending.sent.some(value => samePendingValue(pending.kind, actual, value))) row.pendingEffectValues.delete(instance);
        else pending.observed = actual;
      }
    }
    for (const [index, pending] of row.pendingSendValues) {
      const send = channel.sends?.[index];
      const actual = send?.level_db ?? 0;
      if (!send || sendIdentity(send) !== pending.identity || samePendingValue("send", actual, pending.value)) row.pendingSendValues.delete(index);
      else if (!samePendingValue("send", actual, pending.observed)) {
        if (!pending.sent.some(value => samePendingValue("send", actual, value))) row.pendingSendValues.delete(index);
        else pending.observed = actual;
      }
    }
    row.link.title = t("通道链接");
    if (xairSkin && channel.mute_group) row.link.title += ` · ${channel.mute_group}`;
    row.link.setAttribute("aria-label", row.link.title);
    row.link.setAttribute("aria-pressed", String(Boolean(channel.mute_group)));
    row.link.textContent = channel.mute_group || "↔";
    const shortcutValue = typeof channel.mute_shortcut === "string" ? channel.mute_shortcut : "";
    row.shortcut.textContent = shortcutValue.replace(/Numpad([0-9])\b/g, "Num$1") || "⌨";
    row.shortcut.setAttribute("data-assigned", String(Boolean(shortcutValue)));
    row.shortcut.title = [t("全局快捷键"), shortcutValue].filter(Boolean).join(" · ");
    row.shortcut.setAttribute("aria-label", row.shortcut.title);
    row.item.hidden = Boolean(channel.hidden);
    row.item.setAttribute("data-align-right", String(Boolean(channel.align_right)));
    row.item.setAttribute("data-first-right", String(Boolean(channel.align_right && !channel.hidden && firstRight)));
    if (channel.align_right && !channel.hidden) firstRight = false;
    const color = channelDisplayColor(channel);
    row.item.style.setProperty("--channel-color", color);
    const channelLabel = state.channelLabels?.[String(channel.id)] ?? channelDisplayName(channel, t);
    row.name.textContent = channelLabel;
    const channelSettingsLabel = hasChannelSettingsButton ? `${channelLabel} · ${t("设置通道")}` : channelLabel;
    row.name.setAttribute("aria-label", channelSettingsLabel);
    if (hasChannelSettingsButton) row.name.title = channelSettingsLabel;
    if (studioSkin) {
      const label = row.name.textContent;
      if (row.jumpLabel.textContent !== label) row.jumpLabel.textContent = label;
      row.jump.title = label;
      row.jump.setAttribute("aria-label", label);
      row.jump.style.setProperty("--channel-color", color);
      row.name.style.setProperty("--studio-name-ink", channelNameInk(color));
      if (studioV2) row.index.textContent = String(position);
      const mono = (channel.channel_mode ?? 0) !== 0;
      row.mode.toggleAttribute("data-mono", mono);
      row.mode.title = t(mono ? "单声道" : "立体声");
      row.mode.setAttribute("aria-label", row.mode.title);
      if (!hudSkin) row.insertSection.caption.textContent = t("效果器");
      row.sendSection.caption.textContent = t("发送");
      const targets = (channel.sends ?? []).map(send => sendLabel(send, state, t));
      row.output.textContent = targets.length > 1 ? `${targets[0]} +${targets.length - 1}` : targets[0] ?? t("空输出");
      row.output.title = `${t("输出")} · ${targets.join(" / ") || t("空输出")}`;
      row.output.setAttribute("aria-label", row.output.title);
      if (hud) hud.updateHudChannel(row, t, label);
    }
    for (const [element, key] of [[row.mute, "channel.mute"], [row.solo, "channel.solo"], [row.recording, "channel.record"]]) {
      const label = host.i18n.t(key);
      element.title = label;
      element.setAttribute("aria-label", label);
    }
    const selectedInput = channel.inputs?.[0];
    const offset = state.graph?.input_pairs?.[selectedInput];
    const endpoint = state.graph?.input_devices?.[selectedInput];
    const bridge = channel.rack?.find(slot => /^@wdm-play-\d+$/.test(slot.alias ?? ""));
    const bridgeIndex = bridge ? Number(bridge.alias.slice("@wdm-play-".length)) : null;
    row.input.textContent = state.inputLabels?.[String(channel.id)] ?? (bridge ? `PLAY ${bridgeIndex * 2 + 1}/${bridgeIndex * 2 + 2}` : channel.virtual_input ? "Audcore In Music" : (endpoint?.backend === "io" ? state.graph?.io_endpoints?.[endpoint.name]?.last_name : endpoint?.name) || (Number.isFinite(offset) ? `${t("输入")} ${offset + 1}/${offset + 2}` : t("空输入")));
    row.input.title = [hudSkin ? t("输入") : "", row.input.textContent, state.inputReasons?.[channel.id]].filter(Boolean).join("\n");
    if ((xairSkin)) {
      row.input.textContent = compactInputLabel(row.input.textContent);
    }
    row.input.setAttribute("aria-label", row.input.title);
    if (!hudSkin) row.gain?.setAttribute("aria-label", `${row.name.textContent} ${t("音量")}`);
    row.meter.setAttribute("aria-label", `${row.name.textContent} ${t("skin.meter")}`);
    row.overload.title = t("清除超限提示");
    row.overload.setAttribute("aria-label", row.overload.title);
    row.meter.setAttribute("data-mono", String((channel.channel_mode ?? 0) !== 0));
    row.meter.setAttribute("data-loudness", String(desiredLoudness));
    row.phase.title = t("相位");
    row.phase.setAttribute("aria-label", row.phase.title);
    const fxLabel = t(("skin.fx_bypass"));
    row.fx.title = (fxLabel);
    row.fx.setAttribute("aria-label", row.fx.title);
    row.syncGain();

    if (xairSkin) {
      row.value.setAttribute("aria-label", `${row.name.textContent} · ${t("音量")} (dB)`);
      row.name.title = channelLabel;
      if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{4,6}$/u.test(channelLabel)) {
        const characters = Array.from(channelLabel);
        const split = Math.ceil(characters.length / 2);
        row.name.textContent = `${characters.slice(0, split).join("")}\n${characters.slice(split).join("")}`;
      }
      row.name.style.setProperty("--xair-name-ink", channelNameInk(color));
      row.index.textContent = String(position).padStart(2, "0");
      row.jump.textContent = channelLabel;
      row.jump.title = channelLabel;
    }
    row.phase.setAttribute("aria-pressed", String(Math.abs(channel.phase ?? 0) > 90));
    row.fx.setAttribute("aria-pressed", String(Boolean(channel.fxBypass)));
    row.solo.setAttribute("aria-pressed", String(Boolean(channel.solo)));
    row.solo.setAttribute("data-safe", String(Boolean(channel.solo_safe)));
    const recordingMark = (studioSkin && !hudSkin ? "●" : "REC");
    row.recording.textContent = (channel.recording_group && !xairSkin) ? `${recordingMark} ${channel.recording_group}` : recordingMark;
    row.recording.setAttribute("data-assigned", String(Boolean(channel.recording_group)));
    row.recording.setAttribute("aria-pressed", String(Boolean(channel.recording)));
    row.recording.setAttribute("aria-disabled", String(Boolean(channel.recording_stopping)));
    const recordingState = t(channel.recording_stopping ? "等待保存" : channel.recording ? "正在录音" : "未录音");
    row.recording.title = `${host.i18n.t("channel.record")} · ${recordingState}`;

    if (((xairSkin)) && channel.recording_group) row.recording.title += ` · ${channel.recording_group}`;
    row.recording.setAttribute("aria-label", row.recording.title);
    row.mute.setAttribute("aria-pressed", String(Boolean(channel.muted)));
    const linked = Boolean(state.graph?.link_groups?.[normalizeLink(channel.mute_group)]?.slots);
    const hostSlots = linkedSlotRows(state.graph, channel.id);
    const effectSlots = (hostSlots);

    const signature = JSON.stringify([state.i18n?.language, effectSlots, effectSlots.map(effect => effect && state.primary?.[effect.instance]), effectSlots.map(effect => effect && state.missingEffects?.[effect.instance]), effectSlots.map(effect => effect && state.effectInfo?.[effect.instance]), effectSlots.map(effect => effect && state.effectLabels?.[effect.instance]), linked, (channel.sends ?? []).map(sendIdentity), (channel.sends ?? []).map(send => sendLabel(send, state, t))]);
    if (signature !== row.signature) {
      const focus = document.activeElement;
      const focusedRow = focus?.closest("[data-effect-instance]");
      const focusedEffect = focusedRow?.parentElement === row.effects ? focusedRow.getAttribute("data-effect-instance") : null;
      const focusedAction = focus?.getAttribute("data-studio-effect-action");
      const effectRows = effectSlots.map((effect, slotIndex) => {
        const element = document.createElement("div");
        element.setAttribute("data-audcore-file-drop", "effect-or-audio");
        const index = effect ? (channel.rack ?? []).findIndex(item => item.instance === effect.instance) : -1;
        const accepts = source => source.channel !== channel.id ||
          ((source.instance !== effect?.instance));
        const drop = source => {
          if (source.channel !== channel.id) { copyEffectToChannel(source, row, effect); return; }

          const target = effect ? { instance:effect.instance, ...effectExpected(channel, effect) } : null;
          const operation = linked ? host.effect.moveSlot(channel.id, source.instance, slotIndex, source.expectedEffect, target) : host.effect.move(channel.id, source.instance, index, source.expectedEffect, target);
          operation.catch(reportError);
        };

        element.addEventListener("dragover", event => {
          if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect="copy";
            element.setAttribute("data-drop-target", "true");
            return;
          }
          if (!draggedEffect || !accepts(draggedEffect)) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = draggedEffect.channel === channel.id ? "move" : "copy";
          element.setAttribute("data-drop-target", "true");
        });
        element.addEventListener("dragleave", () => element.removeAttribute("data-drop-target"));
        element.addEventListener("drop", event => {
          element.removeAttribute("data-drop-target");
          if (insertDroppedEffect(event,row,effect)) return;
          if (!draggedEffect || !accepts(draggedEffect)) return;
          event.preventDefault();
          const source = draggedEffect;
          draggedEffect = null;
          drop(source);
        });
        if (!effect) {

          element.setAttribute("aria-hidden", "true");
          element.setAttribute("data-empty", "true");
          return element;
        }
        const fileName = typeof effect.path === "string" ? effect.path.split(/[\\/]/).filter(Boolean).at(-1) : "";
        const effectLabel = state.effectLabels?.[effect.instance] ?? (effect.alias || state.effectInfo?.[effect.instance]?.name || effect.name || fileName || t("效果器"));

        if (!hasEffectControls) element.textContent = effectLabel;
        const primary = state.primary?.[effect.instance];
        const unavailable = Boolean(effect.offline || state.missingEffects?.[effect.instance]);
        element.title = unavailable ? `${effectLabel} · ${t("效果器暂不可用")}` : primary ? `${effectLabel} · ${primary.label} ${primaryText(primary)}` : `${effectLabel} · ${t("干湿")} ${Math.round((effect.wet ?? 1) * 100)}%`;
        if (studioV2 || (studioSkin && primary && !unavailable)) {
          const previewValue = document.createElement("span");
          previewValue.className = "studio-effect-value";
          previewValue.setAttribute("aria-hidden", "true");
          if (primary && !unavailable) {
            const position = primary.inverted ? 1 - primary.normalized : primary.normalized;
            const readout = studioV2 ? document.createElement("span") : previewValue;
            readout.textContent = primaryText(primary);
            if (studioV2) previewValue.append(readout);
            previewValue.style.setProperty("--studio-fill", `${position * 100}%`);
            previewValue.setAttribute("data-measured", "");
          }
          element.append(previewValue);
          element.setAttribute("data-studio-primary", "");
        }
        element.setAttribute("data-effect-instance", String(effect.instance));
        element.setAttribute("data-unavailable", String(unavailable));
        element.setAttribute("aria-label", element.title);
        element.setAttribute("role", hasEffectControls ? "group" : "button");
        element.setAttribute("data-bypass", String(Boolean(effect.bypass)));
        element.setAttribute("draggable", "true");
        if (!hasEffectControls) element.tabIndex = 0;
        element.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown Control+ArrowUp Control+ArrowDown Control+Home");
        const available = () => {
          const current = (row.channel.rack ?? []).find(item => item.instance === effect.instance);
          return Boolean(current && effectIdentity(row.channel, current) === effectIdentity(channel, effect) && !current.offline && !row.state?.missingEffects?.[effect.instance]);
        };
        if (hasEffectControls) {
          const power = button("⏻", `${effectLabel} · ${t("skin.fx_bypass")}`, async event => {
            event.stopPropagation();
            if (!available() || power.getAttribute("aria-busy") === "true") return;
            const current = row.channel.rack.find(item => item.instance === effect.instance);
            power.setAttribute("aria-busy", "true");
            try {
              await host.effect.setBypass(channel.id, current.instance, !current.bypass, effectExpected(row.channel, current));
            } catch (error) {
              reportError(error);
            } finally {
              power.removeAttribute("aria-busy");
            }
          });
          power.setAttribute("data-studio-effect-action", "power");
          power.setAttribute("aria-pressed", String(Boolean(effect.bypass)));
          power.disabled = unavailable;
          power.addEventListener("pointerdown", event => event.stopPropagation());
          power.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          });
          const editor = document.createElement("button");
          editor.type = "button";
          editor.textContent = effectLabel;
          editor.setAttribute("aria-label", element.title);
          editor.setAttribute("data-studio-effect-action", "editor");

          element.prepend(power, editor);
        }
        const adjustWet = (delta, minimumStep = false) => {
          const current = (row.channel.rack ?? []).find(item => item.instance === effect.instance);
          if (!current || !available()) return;
          const parameter = row.state?.primary?.[effect.instance];
          const pending = row.pendingEffectValues.get(effect.instance);
          if (parameter) {
            const base = pending?.kind === "primary" && pending.parameter === parameter.id ? pending.value : parameter.normalized;
            const position = parameter.inverted ? 1 - base : base;
            const next = Math.max(0, Math.min(1, position + delta));
            const raw = parameter.inverted ? 1 - next : next;
            const range = parameter.maximum - parameter.minimum;
            let quantized = primaryPlain(parameter, raw);
            let normalized = Math.pow((quantized - parameter.minimum) / range, parameter.skew);
            // Discrete parameters may span more than one keyboard/wheel tick.
            // Advance one real step without changing the finer drag gesture.
            if (minimumStep && next !== position && Math.abs(normalized - base) < 1e-9) {
              const direction = Math.sign(delta) * (parameter.inverted ? -1 : 1);
              quantized = Math.max(parameter.minimum, Math.min(parameter.maximum, quantized + direction * parameter.step));
              normalized = Math.pow((quantized - parameter.minimum) / range, parameter.skew);
            }
            if (Math.abs(normalized - base) < 1e-9) return;
            const same = pending?.kind === "primary" && pending.parameter === parameter.id;
            const request = { kind: "primary", identity: effectIdentity(channel, effect), parameter: parameter.id, value: normalized, observed: same ? pending.observed : parameter.normalized, sent: [...(same ? pending.sent : []), normalized].slice(-256) };
            row.pendingEffectValues.set(effect.instance, request);
            host.effect.setPrimary(channel.id, effect.instance, parameter.id, normalized, effectExpected(channel, effect)).catch(error => {
              if (row.pendingEffectValues.get(effect.instance) !== request) return;
              row.pendingEffectValues.delete(effect.instance);
              reportError(error);
            });
          } else {
            const base = pending?.kind === "wet" ? pending.value : (current.wet ?? 1);
            const wet = Math.max(0, Math.min(1, Math.round((base + delta) * 100) / 100));
            if (Math.abs(wet - base) < 1e-9) return;
            const same = pending?.kind === "wet";
            const request = { kind: "wet", identity: effectIdentity(channel, effect), value: wet, observed: same ? pending.observed : (current.wet ?? 1), sent: [...(same ? pending.sent : []), wet].slice(-256) };
            row.pendingEffectValues.set(effect.instance, request);
            host.effect.setWet(channel.id, effect.instance, wet, effectExpected(channel, effect)).catch(error => {
              if (row.pendingEffectValues.get(effect.instance) !== request) return;
              row.pendingEffectValues.delete(effect.instance);
              reportError(error);
            });
          }
        };
        element.addEventListener("pointerdown", event => {
          if (!event.ctrlKey || event.button !== 0) return;
          event.preventDefault();
          const pointer = event.pointerId;
          let previousX = event.clientX;
          const primaryId = row.state?.primary?.[effect.instance]?.id ?? null;
          const currentPosition = () => {
            const parameter = row.state?.primary?.[effect.instance];
            const current = (row.channel.rack ?? []).find(item => item.instance === effect.instance);
            if (!current || !available() || (parameter?.id ?? null) !== primaryId) return null;
            const pending = row.pendingEffectValues.get(effect.instance);
            if (parameter) {
              const value = pending?.kind === "primary" && pending.parameter === parameter.id ? pending.value : parameter.normalized;
              return parameter.inverted ? 1 - value : value;
            }
            return pending?.kind === "wet" ? pending.value : (current.wet ?? 1);
          };
          let position = currentPosition();
          if (position === null) return;
          let ready = false;
          let started = false;
          let queuedDelta = 0;
          let finished = false;
          const previousGesture = gestureTail;
          const gestureGeneration = pageGeneration;
          let releaseGesture;
          gestureTail = new Promise(resolve => { releaseGesture = resolve; });
          const endGesture = () => host.history.endEdit().catch(reportError).finally(releaseGesture);
          let commitAfterRelease = false;
          const cleanup = () => {
            if (finished) return;
            finished = true;
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", finish);
            window.removeEventListener("pointercancel", cancelPointer);
            window.removeEventListener("blur", cleanup);
            window.removeEventListener("pagehide", cleanup);
            document.removeEventListener("visibilitychange", onVisibility);
            if (ready) endGesture();
          };
          const finish = end => { if (end.pointerId === pointer) { commitAfterRelease = true; cleanup(); } };
          const cancelPointer = end => { if (end.pointerId === pointer) cleanup(); };
          const onVisibility = () => { if (document.hidden) cleanup(); };
          const move = next => {
            if (next.pointerId !== pointer) return;
            const delta = (next.clientX - previousX) / 200 * (next.shiftKey ? 0.1 : 1);
            if (started) position = Math.max(0, Math.min(1, position + delta));
            else queuedDelta += delta;
            previousX = next.clientX;
            const base = currentPosition();
            if (base === null) { cleanup(); return; }
            if (ready) adjustWet(position - base);
          };
          previousGesture.then(() => {
            if (pageUnavailable || gestureGeneration !== pageGeneration || document.hidden || (finished && !commitAfterRelease)) { releaseGesture(); return; }
            const base = currentPosition();
            if (base === null) { cleanup(); releaseGesture(); return; }
            position = Math.max(0, Math.min(1, base + queuedDelta));
            started = true;
            return host.history.beginEdit().then(() => {
              ready = true;
              const base = currentPosition();
              if (!pageUnavailable && gestureGeneration === pageGeneration && !document.hidden && base !== null && (!finished || commitAfterRelease)) adjustWet(position - base);
              if (finished) endGesture();
            }).catch(error => { cleanup(); releaseGesture(); reportError(error); });
          });
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", finish);
          window.addEventListener("pointercancel", cancelPointer);
          window.addEventListener("blur", cleanup);
          window.addEventListener("pagehide", cleanup);
          document.addEventListener("visibilitychange", onVisibility);
        });
        element.addEventListener("wheel", event => {
          if (!event.ctrlKey || !event.deltaY) return;
          event.preventDefault();
          adjustWet(event.deltaY < 0 ? 0.01 : -0.01, true);
        }, { passive: false });
        const resetPrimary = () => {
          const parameter = row.state?.primary?.[effect.instance];
          const current = (row.channel.rack ?? []).find(item => item.instance === effect.instance);
          if (!current || !available()) return;
          const request = parameter
            ? { kind: "primary", identity: effectIdentity(channel, effect), parameter: parameter.id, value: parameter.default_normalized, observed: parameter.normalized, sent: [parameter.default_normalized] }
            : { kind: "wet", identity: effectIdentity(channel, effect), value: 1, observed: current.wet ?? 1, sent: [1] };
          row.pendingEffectValues.set(effect.instance, request);
          const expected = effectExpected(channel, effect);
          const operation = parameter ? host.effect.resetPrimary(channel.id, effect.instance, parameter.id, expected) : host.effect.setWet(channel.id, effect.instance, 1, expected);
          operation.then(() => {
            if (Math.abs(request.observed - request.value) < 1e-9 && row.pendingEffectValues.get(effect.instance) === request) row.pendingEffectValues.delete(effect.instance);
          }).catch(error => {
            if (row.pendingEffectValues.get(effect.instance) !== request) return;
            row.pendingEffectValues.delete(effect.instance);
            reportError(error);
          });
        };
        const openEditor = () => {
          const current = (row.channel.rack ?? []).find(item => item.instance === effect.instance);
          if (current && available()) host.effect.openEditor(channel.id, effect.instance, effectExpected(channel, effect)).catch(reportError);
        };
        element.addEventListener("click", event => {

          if (!event?.ctrlKey) openEditor();
        });
        element.addEventListener("dblclick", event => {
          if (!event.ctrlKey) return;
          event.preventDefault();
          resetPrimary();
        });
        element.addEventListener("keydown", event => {
          if (event.ctrlKey && event.key === "Home") { event.preventDefault(); resetPrimary(); return; }
          if (event.ctrlKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            adjustWet(event.key === "ArrowUp" ? 0.01 : -0.01, true);
            return;
          }
          if (!event.altKey && !event.ctrlKey && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            openEditor();
            return;
          }
          if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
          const target = slotIndex + (event.key === "ArrowUp" ? -1 : 1);
          if (target < 0 || target >= effectSlots.length) return;
          event.preventDefault();


          const targetIndex = linked ? target : (channel.rack ?? []).findIndex(item => item.instance === effectSlots[target]?.instance);
          const targetEffect = effectSlots[target];
          const expectedTarget = targetEffect ? { instance:targetEffect.instance, ...effectExpected(channel, targetEffect) } : null;
          const operation = linked ? host.effect.moveSlot(channel.id, effect.instance, targetIndex, effectExpected(channel, effect), expectedTarget) : host.effect.move(channel.id, effect.instance, targetIndex, effectExpected(channel, effect), expectedTarget);
          operation.catch(reportError);
        });
        element.addEventListener("dragstart", event => {
          if (event.ctrlKey) { event.preventDefault(); return; }
          draggedEffect = { channel: channel.id, instance: effect.instance, expectedEffect:effectExpected(channel, effect) };
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "copyMove";
            event.dataTransfer.setData("text/plain", "audcore-effect");
          }
        });
        element.addEventListener("dragend", () => {
          draggedEffect = null;
          element.removeAttribute("data-drop-target");
          for (const target of root.querySelectorAll?.('[data-drop-target="true"]') ?? []) target.removeAttribute("data-drop-target");
        });
        element.addEventListener("contextmenu", event => {
          event.preventDefault();
          event.stopPropagation();
          const rect = element.getBoundingClientRect();
          const anchor = event.clientX === 0 && event.clientY === 0 ? { x: rect.left, y: rect.bottom } : { x: event.clientX, y: event.clientY };
          host.menu.openEffect(channel.id, effect.instance, anchor, effectExpected(channel, effect)).catch(reportError);
        });
        return element;
      });
      {
        const addEffect = button("＋", t("添加效果器"), () => host.effect.openBrowser(channel.id, channelExpected(channel)).catch(reportError));
        addEffect.setAttribute("data-audcore-file-drop", "effect-or-audio");
        addEffect.addEventListener("dragover", event => {
          if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect="copy";
            addEffect.setAttribute("data-drop-target", "true");
            return;
          }
          if (draggedEffect && draggedEffect.channel !== channel.id) {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
            addEffect.setAttribute("data-drop-target", "true");
          }
        });
        addEffect.addEventListener("dragleave", () => addEffect.removeAttribute("data-drop-target"));
        addEffect.addEventListener("drop", event => {
          addEffect.removeAttribute("data-drop-target");
          if (insertDroppedEffect(event,row,null)) return;
          if (!draggedEffect || draggedEffect.channel === channel.id) return;
          event.preventDefault();
          const source = draggedEffect;
          draggedEffect = null;
          copyEffectToChannel(source, row, null);
        });
        if (xairSkin) {
          row.effects.replaceChildren(...effectRows, row.latency);
          const focusedAdd = row.addEffect && focus === row.addEffect;
          row.addEffect?.remove();
          row.effectHeader.append(addEffect);
          row.addEffect = addEffect;
          if (focusedAdd) addEffect.focus();
        } else if (studioSkin) {
          const focusedAdd = row.addEffect && focus === row.addEffect;
          row.effects.replaceChildren(...effectRows, ...(studioV2 || hudSkin ? [] : [row.latency]));
          row.addEffect?.remove();
          row.insertSection.header.append(addEffect);
          row.addEffect = addEffect;
          if ((studioV2 || hudSkin) && focusedAdd) addEffect.focus();
        } else {
          row.effects.replaceChildren(...effectRows, row.latency, addEffect);
        }
      }
      if (focusedEffect !== null) {
        const focusedIndex = effectSlots.findIndex(effect => effect && String(effect.instance) === focusedEffect);
        if (focusedIndex >= 0) {
          const next = effectRows[focusedIndex];
          (focusedAction ? next.querySelector(`[data-studio-effect-action="${focusedAction}"]`) : next)?.focus();
        }
      }
      const sendRows = (channel.sends ?? []).map((send, index) => {
        const element = document.createElement("div");
        const label = sendLabel(send, state, t);

        element.setAttribute("role", "slider");
        element.setAttribute("aria-label", label);
        element.setAttribute("aria-valuemin", "-60");
        element.setAttribute("aria-valuemax", "6");
        element.tabIndex = 0;
        const openPrimary = () => {
          const rect = element.getBoundingClientRect();
          host.menu.openSendPrimary(channel.id, index, { x: rect.left, y: rect.bottom }, sendExpected(send, channel)).catch(reportError);
        };
        const adjust = delta => {
          const current = row.channel.sends?.[index];
          if (!current || sendIdentity(current) !== sendIdentity(send)) return;
          const identity = sendIdentity(current);
          const pending = row.pendingSendValues.get(index);
          const same = pending?.identity === identity;
          const actual = current.level_db ?? 0;
          const base = same ? pending.value : actual;
          const db = Math.max(-60, Math.min(row.state?.channelControls?.gainLimit ? 0 : 6, Math.round((base + delta) * 10) / 10));
          if (Math.abs(db - base) < 1e-9) return;
          const request = { identity, value: db, observed: same ? pending.observed : actual, sent: [...(same ? pending.sent : []), db].slice(-256) };
          row.pendingSendValues.set(index, request);
          host.channel.setSendLevel(channel.id, index, db, sendExpected(current, channel)).catch(error => {
            if (row.pendingSendValues.get(index) !== request) return;
            row.pendingSendValues.delete(index);
            reportError(error);
          });
        };
        element.addEventListener("pointerdown", event => {
          if (event.button !== 0) return;
          if (event.ctrlKey) {
            event.preventDefault();
            const pointer = event.pointerId, startX = event.clientX, startY = event.clientY;
            const expected = structuredClone(row.channel.sends ?? []);
            const expectedChannel = { chain_uuid:channel.chain_uuid ?? null, source_uuid:channel.source_uuid ?? null };
            let moved = false, x = startX, y = startY;
            const cleanup = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", finish);
              window.removeEventListener("pointercancel", cancel);
              window.removeEventListener("blur", cleanup);
              window.removeEventListener("pagehide", cleanup);
              document.removeEventListener("visibilitychange", visibility);
            };
            const move = next => {
              if (next.pointerId !== pointer) return;
              x = next.clientX; y = next.clientY;
              moved ||= Math.abs(x - startX) + Math.abs(y - startY) >= 4;
            };
            const finish = next => {
              if (next.pointerId !== pointer) return;
              cleanup();
              if (rows.get(channel.id) !== row || JSON.stringify(row.channel.sends) !== JSON.stringify(expected) || (row.channel.chain_uuid ?? null) !== expectedChannel.chain_uuid || (row.channel.source_uuid ?? null) !== expectedChannel.source_uuid) return;
              if (!moved) { adjust(-(row.pendingSendValues.get(index)?.value ?? send.level_db ?? 0)); return; }
              const targets = [...row.sends.children].slice(0, expected.length);
              const to = targets.findIndex(target => {
                const rect = target.getBoundingClientRect();
                return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
              });
              if (to >= 0 && to !== index) host.channel.moveSend(channel.id, index, to, expected, expectedChannel).catch(reportError);
            };
            const cancel = next => { if (next.pointerId === pointer) cleanup(); };
            const visibility = () => { if (document.hidden) cleanup(); };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", finish);
            window.addEventListener("pointercancel", cancel);
            window.addEventListener("blur", cleanup);
            window.addEventListener("pagehide", cleanup);
            document.addEventListener("visibilitychange", visibility);
            return;
          }
          event.preventDefault();
          const pointer = event.pointerId;
          const startX = event.clientX, startY = event.clientY;
          const identity = sendIdentity(send);
          const generation = pageGeneration;
          let x = startX, y = startY, origin = null, ready = false, finished = false, commit = false;
          const currentLevel = () => {
            const current = row.channel.sends?.[index];
            if (rows.get(channel.id) !== row || !current || sendIdentity(current) !== identity) return null;
            const pending = row.pendingSendValues.get(index);
            return pending?.identity === identity ? pending.value : (current.level_db ?? 0);
          };
          const apply = () => {
            const current = currentLevel();
            if (current === null || origin === null || Math.abs(x - startX) + Math.abs(y - startY) < 4) return;
            const target = Math.max(-60, Math.min(row.state?.channelControls?.gainLimit ? 0 : 6, origin + (x - startX) / 74 * 66 / (1 + Math.abs(y - startY) / 55)));
            adjust(target - current);
          };
          const previous = gestureTail;
          let release;
          gestureTail = new Promise(resolve => { release = resolve; });
          const endEdit = () => host.history.endEdit().catch(reportError).finally(release);
          const cleanup = shouldCommit => {
            if (finished) return;
            finished = true;
            commit = shouldCommit;
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", finish);
            window.removeEventListener("pointercancel", cancel);
            window.removeEventListener("blur", loseFocus);
            window.removeEventListener("pagehide", loseFocus);
            document.removeEventListener("visibilitychange", visibility);
            if (ready) endEdit();
          };
          const move = next => {
            if (next.pointerId !== pointer) return;
            x = next.clientX; y = next.clientY;
            if (currentLevel() === null) { cleanup(false); return; }
            if (ready) apply();
          };
          const finish = next => {
            if (next.pointerId !== pointer) return;
            const click = Math.abs(x - startX) + Math.abs(y - startY) < 4;
            cleanup(true);
            if (click) gestureTail.then(() => {
              if (pageUnavailable || generation !== pageGeneration || document.hidden || currentLevel() === null) return;
              openPrimary();
            });
          };
          const cancel = next => { if (next.pointerId === pointer) cleanup(false); };
          const loseFocus = () => cleanup(false);
          const visibility = () => { if (document.hidden) cleanup(false); };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", finish);
          window.addEventListener("pointercancel", cancel);
          window.addEventListener("blur", loseFocus);
          window.addEventListener("pagehide", loseFocus);
          document.addEventListener("visibilitychange", visibility);
          previous.then(() => {
            if (pageUnavailable || generation !== pageGeneration || document.hidden || (finished && !commit)) { release(); return; }
            origin = currentLevel();
            if (origin === null) { cleanup(false); release(); return; }
            return host.history.beginEdit().then(() => {
              ready = true;
              if (!pageUnavailable && generation === pageGeneration && !document.hidden && (!finished || commit)) apply();
              if (finished) endEdit();
            }).catch(error => { cleanup(false); release(); reportError(error); });
          });
        });
        element.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openPrimary(); return; }
          if (event.key === "ArrowUp" || event.key === "ArrowRight") { event.preventDefault(); adjust(0.1); }
          if (event.key === "ArrowDown" || event.key === "ArrowLeft") { event.preventDefault(); adjust(-0.1); }
        });
        element.addEventListener("wheel", event => {
          if (!event.deltaY) return;
          event.preventDefault();
          adjust(event.deltaY < 0 ? 0.1 : -0.1);
        }, { passive: false });
        element.addEventListener("contextmenu", event => {
          event.preventDefault();
          event.stopPropagation();
          const rect = element.getBoundingClientRect();
          const anchor = event.clientX === 0 && event.clientY === 0 ? { x: rect.left, y: rect.bottom } : { x: event.clientX, y: event.clientY };
          host.menu.openSend(channel.id, index, anchor, sendExpected(send, channel)).catch(reportError);
        });
        if (!studioV2) return element;
        const slot = document.createElement("div");
        slot.className = "studio-v2-send";
        const header = document.createElement("div");
        header.className = "studio-v2-send-header";
        const power = button("⏻", `${t("开关")} · ${label}`, async () => {
          const current = row.channel.sends?.[index];
          if (!current || sendIdentity(current) !== sendIdentity(send) || power.getAttribute("aria-busy") === "true") return;
          power.setAttribute("aria-busy", "true");
          try {
            await host.channel.setSendEnabled(channel.id, index, current.enabled === false, sendExpected(current, row.channel));
          } catch (error) {
            reportError(error);
          } finally {
            power.removeAttribute("aria-busy");
          }
        });
        const route = button(label, label, () => {
          const rect = route.getBoundingClientRect();
          host.menu.openSend(channel.id, index, { x: rect.left, y: rect.bottom }, sendExpected(send, channel)).catch(reportError);
        });
        header.append(power, route);
        slot.append(header, element);
        return slot;
      });
      {
        row.addSend.title = t("添加路由");
        row.addSend.setAttribute("aria-label", row.addSend.title);
        for (const element of [...row.sends.children]) {
          if (element !== row.addSend) element.remove();
        }
        if (studioSkin || xairSkin) row.sends.append(...sendRows);
        else for (const element of sendRows) row.sends.insertBefore(element, row.addSend);
      }
      row.signature = signature;
    }
    for (let index = 0; index < (channel.sends ?? []).length; index += 1) {
      const send = channel.sends[index];
      const db = send.level_db ?? 0;
      const slot = row.sends.children[index];
      const element = studioV2 ? slot.lastElementChild : slot;
      const label = sendLabel(send, state, t);
      const displayDb = (xairSkin) ? db.toFixed(1) : db;
      if (studioV2) {
        const power = slot.firstElementChild.firstElementChild;
        power.setAttribute("aria-pressed", String(send.enabled !== false));
        slot.setAttribute("data-enabled", String(send.enabled !== false));
      } else element.textContent = studioSkin ? label : `${label} · ${displayDb} dB`;
      if (studioSkin) {
        const maximum = state.channelControls?.gainLimit ? 0 : 6;
        const fraction = Math.max(0, Math.min(1, (db + 60) / (maximum + 60)));
        element.style.setProperty("--studio-fill", `${fraction * 100}%`);
        element.setAttribute("aria-valuemax", String(maximum));
        element.setAttribute("aria-valuetext", `${db} dB`);
      }
      const projected = state.sendReasons?.[channel.id]?.[index];
      const target = projected?.dest;
      const dest = send.dest;
      const sameTarget = target?.kind === dest?.kind && (dest?.kind === "chain" ? target.id === dest.id : dest?.kind === "sidechain" ? target.instance === dest.instance : dest?.kind === "virtual_recording" ? target.endpoint === dest.endpoint : dest?.kind === "output" && target.pair === dest.pair);
      const reason = (sameTarget && projected?.channel && sameChannelIdentity(projected.channel, channel) ? projected.reason : null) ?? (dest?.kind === "output" ? state.outputReasons?.[dest.pair] : null);
      const title = xairSkin || studioSkin ? `${label} · ${displayDb} dB` : (label);
      element.title = [title, reason].filter(Boolean).join("\n");
      element.setAttribute("aria-label", [label, reason].filter(Boolean).join("\n"));
      element.setAttribute("aria-valuenow", String(db));
      element.setAttribute("data-enabled", String(send.enabled !== false));
    }
  }
  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.pendingToggles.clear();
      row.fxControl.cancel();
      row.pendingEffectValues.clear();
      row.pendingSendValues.clear();
      row.pendingGain = null;
      row.item.remove();
      row.jump?.remove();
      rows.delete(id);
    }
  }
  if (studioSkin) {
    studioHeading.textContent = t("通道");
    root.setAttribute("aria-label", t("调音台"));
    studioEmpty.hidden = firstStudioChannel !== null;
    studioEmpty.textContent = t("暂无通道");
    if (!studioSelection || studioSelection.jump.hidden || !studioSelection.jump.isConnected) {
      selectStudioChannel(firstStudioChannel);
    }
  }
  if (xairSkin) {
    const visible = (state.channels ?? []).filter(channel => !channel.hidden);
    const destinations = new Set(visible.flatMap(channel => (channel.sends ?? [])
      .filter(send => send.dest?.kind === "chain").map(send => send.dest.id)));
    const outputs = visible.filter(channel => channel.align_right || destinations.has(channel.id) ||
      channel.sends?.some(send => ["output", "virtual_recording"].includes(send.dest?.kind)));
    const jumps = outputs.map(channel => rows.get(channel.id).jump);
    const wanted = new Set(jumps);
    for (const jump of [...xairRouting.children]) {
      if (!wanted.has(jump)) jump.remove();
    }
    jumps.forEach((jump, index) => {
      if (xairRouting.children[index] !== jump) xairRouting.insertBefore(jump, xairRouting.children[index] ?? null);
    });
    xairRoutingTitle.hidden = jumps.length === 0;
    if (!affected) xairRoutingTitle.textContent = t("输出");
    xairEmpty.hidden = visible.length > 0;
    if (!affected) xairEmpty.textContent = t("暂无通道");
    const selection = xairSelection && visible.some(channel => rows.get(channel.id) === xairSelection)
      ? xairSelection : rows.get(visible[0]?.id) ?? null;
    selectXairChannel(selection);
    if (!affected) {
      for (const element of document.querySelectorAll("[data-label]")) element.textContent = t(element.getAttribute("data-label"));
    }
  }



  if (draggedSend) markSendTargets(state);
}

let firstRendered;
const stateReady = new Promise(resolve => { firstRendered = resolve; });
const pageReady = document.readyState === "complete" ? Promise.resolve() : new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
const needsNativeStartup = typeof host.window.requiresStartup === "function"
  ? host.window.requiresStartup()
  : Boolean(window.__AUDCORE_NATIVE_MOCK__ && window.chrome?.webview);
const startupController = needsNativeStartup ? new AbortController() : null;
const startup = startupController
  ? revealNativeCover({ post: message => {
      if (message.phase === "show") host.window.showUnderCover();
      else if (message.phase === "complete") host.window.presentFrame();
      else host.window.startupFailed();
    }, stateReady, fontsReady: document.fonts.ready, pageReady, signal: startupController.signal })
  : null;
startup?.catch(reportError);
let dispose;
try {
  dispose = await mountSkin(host, (state, event) => {
    try { render(state, event); firstRendered(); }
    catch (error) { startupController?.abort(error); throw error; }
  }, reportError, { borrowState: true });
} catch (error) {
  startupController?.abort(error);
  throw error;
}
const disposeMeters = mountMeters(host, document, meters => {
  if (audioRunning === false) return;

  const level = peak => peak > 0 ? meterLevel(20 * Math.log10(peak)) : 0;
  for (const meter of meters) {
    const row = rows.get(meter.id);
    if (!row || !Number.isFinite(meter.peak)) continue;
    const left = Number.isFinite(meter.peak_l) ? meter.peak_l : meter.peak;
    const right = Number.isFinite(meter.peak_r) ? meter.peak_r : meter.peak;
    const mono = (row.channel.channel_mode ?? 0) !== 0;
    row.meterLeft.style.transform = `scaleY(${level(mono ? Math.max(left, right) : left)})`;
    row.meterRight.style.transform = `scaleY(${level(right)})`;
    const loudnessLevel = value => Number.isFinite(value) ? meterLevel(value) : 0;
    // A null stereo value means this side has no valid measurement yet. Only
    // use the combined value when the host supplied no stereo measurement.
    const stereo = Array.isArray(meter.stereo_loudness) ? meter.stereo_loudness : null;
    const leftLoudness = stereo ? stereo[0] : meter.loudness;
    const rightLoudness = stereo ? stereo[1] : meter.loudness;
    const monoLoudness = Math.max(loudnessLevel(leftLoudness), loudnessLevel(rightLoudness));
    row.loudnessLeft.style.transform = `scaleY(${desiredLoudness ? (mono ? monoLoudness : loudnessLevel(leftLoudness)) : 0})`;
    row.loudnessRight.style.transform = `scaleY(${desiredLoudness ? loudnessLevel(rightLoudness) : 0})`;
    row.meter.setAttribute("aria-valuenow", level(Math.max(left, right)).toFixed(2));
    const peak = Math.max(left, right);
    if (row.hud) {
      const reading = peak > 0 ? (20 * Math.log10(peak)).toFixed(1) : "−∞";
      hud.paintHudMeter(row, level(peak), reading);
      row.meter.setAttribute("aria-valuetext", `${reading} dBFS`);
    }
    if (row.peak) {
      const reading = peak > 0 ? (20 * Math.log10(peak)).toFixed(1) : "−∞";
      if (row.peak.textContent !== reading) row.peak.textContent = reading;
      row.meter.setAttribute("aria-valuetext", `${reading} dB`);
    }
    if (peak > 1 && (row.overloadPeak === null || peak > row.overloadPeak)) {
      row.overloadPeak = peak;
      row.overload.textContent = `+${(20 * Math.log10(peak)).toFixed(1)}`;
      row.overload.disabled = false;
      row.overload.setAttribute("data-overload", "true");
    }
  }
}, reportError, { loudness: desiredLoudness });
meterSubscription = disposeMeters;
window.addEventListener("pageshow", () => { pageUnavailable = false; });
window.addEventListener("pagehide", event => {


  finishSendDrag();
  transportControl.cancel();
  resetFxQueue();
  for (const row of rows.values()) { row.pendingToggles.clear(); row.fxControl.cancel(); row.pendingEffectValues.clear(); row.pendingSendValues.clear(); row.pendingGain = null; }
  pageUnavailable = true;
  pageGeneration++;
  draggedChannel = null;
  preview?.close();
  // A page in the back/forward cache can resume without running this module again.
  if (event.persisted) return;

  disposeMeters();
  disposeNotices?.();
  dispose();
  if (ownsHost) host.close();
}, { once: false });
