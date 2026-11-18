// Compatibility for older skin hosts and legacy pages. The current host
// supplies displayColor from audcore_protocol::channel_display::color.
export const channelPalette = ["#38b9ec", "#f3ad50", "#33d69a", "#a879e8", "#24c5d9", "#9baab9"];

export function channelDisplayColor({ id, color, displayColor }) {
  if (typeof displayColor === "string" && /^#[0-9a-f]{6}$/i.test(displayColor)) return displayColor;
  const hex = typeof color === "string" ? color.replace(/^#+/, "") : "";
  if (/^\+?[0-9a-f]+$/i.test(hex)) {
    const value = Number.parseInt(hex, 16);
    if (value <= 0xffffffff) return "#" + (value & 0xffffff).toString(16).padStart(6, "0");
  }
  return channelPalette[id % channelPalette.length];
}
