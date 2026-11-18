// Display names are derived from stored data; translations never enter the graph.
const iconLabels = new Map([
  ["🎤", "唱歌"],
  ["🎙️", "麦克风"],
  ["🎧", "监听"],
  ["🎸", "吉他"],
  ["🎹", "键盘"],
  ["🥁", "鼓"],
  ["🎺", "小号"],
  ["🎻", "小提琴"],
  ["🔊", "扬声器"],
  ["🎚️", "混音"],
  ["🎛️", "效果器"],
  ["🎵", "音乐"],
  ["📻", "电台"],
  ["💬", "聊天"],
  ["⭐", "收藏"],
  ["🔥", "热情"],
  ["🏛️", "大厅"],
  ["🎶", "伴奏"],
  ["🗣️", "人声湿声"],
  ["🔀", "总混音"],
  ["📤", "输出"],
  ["🌊", "混响"]
]);

export function channelDisplayName(channel, translate) {
  const number = Math.min(channel.id + 1, 0xffffffff);
  const name = channel.name ?? "";
  if (name && !["通道", "Ch", "通路"].some(prefix => name === `${prefix} ${number}`)) return name;
  const icon = iconLabels.get(channel.icon);
  if (icon) return translate(icon);
  return translate("通道 {}").replace("{}", String(number));
}

export function compactInputLabel(label) {
  const match = /^(?:(?:virtual\s+)?(rec)|(?:analog\s+)?in(?:put)?)\s+(\d+(?:\/\d+)?)(?=\s*(?:$|·|\(|（))/i.exec(label);
  return match ? `${match[1] ? "Rec" : "In"} ${match[2]}` : label;
}

export function compactOutputLabel(label) {
  const match = /^(?:(?:analog\s+)?out(?:put)?|(playback)|virtual\s+(play))\s+(\d+(?:\/\d+)?)(?=\s*(?:$|·|\(|（))/i.exec(label);
  if (!match) return label;
  const prefix = match[1] ? "BACK" : match[2] ? "Play" : "Out";
  return `${prefix} ${match[3]}`;
}
