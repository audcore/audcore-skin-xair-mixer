// Resolve destinations from the same graph snapshot; do not persist translated labels.
export function sendLabel(send, state, t = text => text) {
  const dest = send?.dest ?? {};
  const chains = state.graph?.chains ?? [];
  if (dest.kind === "chain") {
    const target = chains.find(chain => chain.id === dest.id);
    return target ? (state.channelLabels?.[String(target.id)] ?? target.name) || `${t("通道")} ${target.id + 1}` : t("通道");
  }
  if (dest.kind === "sidechain") {
    const hostLabel = state.sidechainLabels?.[String(dest.instance)];
    if (typeof hostLabel === "string") return hostLabel;
    const effect = chains.flatMap(chain => chain.rack ?? []).find(slot => slot.instance === dest.instance);
    return `${effect?.alias || state.effectInfo?.[dest.instance]?.name || effect?.name || t("插件")} · ${t("侧链")}`;
  }
  if (dest.kind === "virtual_recording") return dest.endpoint === "vocal" ? "Audcore REC Vocal" : "Audcore REC Mix";
  if (dest.kind === "output") {
    const channel = send.output_channel == null ? "stereo" : String(send.output_channel);
    const label = state.outputLabels?.[dest.pair]?.[channel];
    if (label) return label;
    const name = state.graph?.output_devices?.[dest.pair]?.name;
    const side = send.output_channel === 0 || send.output_channel === 1 ? send.output_channel : null;
    if (name) return side === null ? name : `${name} · ${side + 1}`;
    const offset = state.graph?.output_pairs?.[dest.pair];
    if (Number.isSafeInteger(offset) && offset >= 0) return side === null ? `${t("输出")} ${offset + 1}/${offset + 2}` : `${t("输出")} ${offset + side + 1}`;
    return `${t("输出")} ${dest.pair + 1}${side === null ? "" : ` · ${side + 1}`}`;
  }
  return t("路由");
}

export function compactSidechainLabel(label, t) {
  const kind = t("侧链");
  const prefix = `${kind} `;
  const suffix = ` · ${kind}`;
  if (label.startsWith(prefix)) return label.slice(prefix.length);
  if (label.endsWith(suffix)) return label.slice(0, -suffix.length);
  return label;
}
