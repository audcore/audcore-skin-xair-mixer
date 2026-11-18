// Same taper as tools/mixer-console/MixerView.h over the Web skin's gain range.
const points = [[12, 0], [10, 8], [5, 28], [0, 49], [-5, 70], [-10, 91],
  [-20, 111], [-30, 132], [-40, 153], [-50, 173], [-60, 179.25]];
const travel = points.at(-1)[1];
export const faderResolution = 10000;
export const faderMarks = points.slice(1, -1).flatMap(([db, position], index) => {
  const next = points[index + 2];
  return [{ db, offset: position / travel }, { offset: (position + next[1]) / (2 * travel) }];
});

function interpolate(value, input, output) {
  const lower = points.findIndex(point => value <= (input === 0 ? -point[input] : point[input]));
  if (lower <= 0) return points[lower === 0 ? 0 : points.length - 1][output];
  const [start, end] = [points[lower - 1], points[lower]];
  const from = input === 0 ? -start[input] : start[input];
  const to = input === 0 ? -end[input] : end[input];
  return start[output] + (end[output] - start[output]) * (value - from) / (to - from);
}

export function faderPosition(db) {
  return Math.round((1 - interpolate(-db, 0, 1) / travel) * faderResolution);
}

export function faderGain(position) {
  return Math.round(interpolate((1 - position / faderResolution) * travel, 1, 0) * 10) / 10 || 0;
}

export function parseFaderGain(value, max) {
  const text = value.trim().replaceAll("−", "-").replace(/\s*dB$/i, "");
  if (/^-(?:∞|inf(?:inity)?)$/i.test(text)) return -60;
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(text)) return null;
  const gain = Number(text.replace(",", "."));
  return gain >= -60 && gain <= max ? Math.round(gain * 10) / 10 : null;
}

// The fixed channel tracks (including gaps and padding) occupy 322px.
export function xairLayout(height, nativeFrame, scrollbarHeight = 0) {
  const scale = height > 1200 ? 2 : 1;
  const viewport = height / scale;
  const available = viewport - (nativeFrame ? 0 : 30) - 36 - scrollbarHeight - 322;
  const rows = Math.max(1, Math.floor((available - 207 - 23) / 14));
  const effects = 23 + rows * 14;
  return { scale, viewport, effects, fader: Math.max(96, available - effects) };
}
