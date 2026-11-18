// ZIP reader used for example-package validation; installation is handled by package-host.
// It accepts ordinary single-disk stored/deflated ZIPs and rejects ZIP64.
import { inflateRawSync } from "node:zlib";
import { validateSkinManifest } from "./web/package-manifest.mjs";

const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_MANIFEST = 64 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function text(bytes) {
  try { return decoder.decode(bytes); }
  catch { throw new Error("invalid UTF-8 archive name"); }
}

function findDirectory(bytes) {
  const first = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= first; offset--) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    if (offset + 22 + bytes.readUInt16LE(offset + 20) !== bytes.length) continue;
    ensure(bytes.readUInt16LE(offset + 4) === 0 && bytes.readUInt16LE(offset + 6) === 0, "multi-disk archive unsupported");
    const count = bytes.readUInt16LE(offset + 10);
    ensure(count !== 0xffff && bytes.readUInt16LE(offset + 8) === count, "ZIP64 or multi-disk archive unsupported");
    ensure(count <= 4096, "too many archive entries");
    const size = bytes.readUInt32LE(offset + 12);
    const start = bytes.readUInt32LE(offset + 16);
    ensure(start !== 0xffffffff && size !== 0xffffffff && start + size === offset, "invalid central directory");
    return { start, size, count };
  }
  throw new Error("ZIP directory not found");
}

function archiveEntries(bytes, directory) {
  const entries = [];
  let offset = directory.start;
  for (let i = 0; i < directory.count; i++) {
    ensure(offset + 46 <= directory.start + directory.size && bytes.readUInt32LE(offset) === 0x02014b50, "invalid central entry");
    const madeBy = bytes.readUInt16LE(offset + 4) >>> 8;
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const disk = bytes.readUInt16LE(offset + 34);
    const attributes = bytes.readUInt32LE(offset + 38);
    const local = bytes.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    ensure(end <= directory.start + directory.size && nameLength > 0, "invalid central entry length");
    ensure((flags & ~0x80e) === 0 && (method === 0 || method === 8), "encrypted or unsupported entry");
    ensure(method !== 0 || !(flags & 6), "invalid stored entry flags");
    ensure(disk === 0 && compressed !== 0xffffffff && size !== 0xffffffff && local !== 0xffffffff, "ZIP64 unsupported");
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    ensure((flags & 0x800) || nameBytes.every(byte => byte < 0x80), "non-UTF-8 name unsupported");
    const name = text(nameBytes);
    const isDirectory = name.endsWith("/");
    // Unix and macOS creators encode the file type in the high mode bits.
    // Other creators are accepted only as DOS/Windows entries.
    ensure(madeBy === 0 || madeBy === 3 || madeBy === 19, "archive creator unsupported");
    const mode = madeBy === 3 || madeBy === 19 ? attributes >>> 16 : 0;
    const isSymlink = (mode & 0xf000) === 0xa000 || Boolean(attributes & 0x400);
    ensure((mode & 0xf000) === 0 || (mode & 0xf000) === 0x8000 || (mode & 0xf000) === 0x4000 || isSymlink, "unsupported file type");
    ensure((mode & 0xf000) !== 0x4000 || isDirectory, "directory metadata mismatch");
    ensure(local + 30 <= directory.start && bytes.readUInt32LE(local) === 0x04034b50, "invalid local header");
    const localFlags = bytes.readUInt16LE(local + 6);
    const localMethod = bytes.readUInt16LE(local + 8);
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    const data = local + 30 + localNameLength + localExtraLength;
    ensure(localFlags === flags && localMethod === method && data <= directory.start && data + compressed <= directory.start, "local header mismatch");
    ensure(nameBytes.equals(bytes.subarray(local + 30, local + 30 + localNameLength)), "local name mismatch");
    if (!(flags & 8)) {
      ensure(bytes.readUInt32LE(local + 14) === checksum && bytes.readUInt32LE(local + 18) === compressed && bytes.readUInt32LE(local + 22) === size, "local size mismatch");
    }
    ensure(!isDirectory || (size === 0 && compressed === 0), "invalid directory content");
    entries.push({ name, size, isDirectory, isSymlink, compressed, checksum, method, data, local });
    offset = end;
  }
  ensure(offset === directory.start + directory.size, "central directory length mismatch");
  const ranges = entries.map(entry => [entry.local, entry.data + entry.compressed]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) ensure(ranges[i][0] >= ranges[i - 1][1], "overlapping entries");
  return entries;
}

function unpackEntry(bytes, entry) {
  const compressed = bytes.subarray(entry.data, entry.data + entry.compressed);
  let result;
  try {
    result = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_FILE });
  } catch { throw new Error("invalid compressed data"); }
  ensure(result.length === entry.size && crc32(result) === entry.checksum, "entry length or CRC mismatch");
  return result;
}

export function readSkinArchive(input) {
  const bytes = Buffer.from(input);
  ensure(bytes.length >= 22 && bytes.length <= MAX_ARCHIVE, "invalid archive size");
  const entries = archiveEntries(bytes, findDirectory(bytes));
  // First pass validates every path, size and type before inflating anything.
  const shape = entries.map(({ name, size, isDirectory, isSymlink }) => ({ name, size, isDirectory, isSymlink }));
  const firstHtml = entries.find(entry => !entry.isDirectory && /\.html$/i.test(entry.name));
  ensure(firstHtml, "HTML entry missing");
  const placeholder = { id: "validation", name: "validation", version: "1.0.0", api: { major: 1, minor: 0 },
    entry: firstHtml.name, window: { default: [1, 1], min: [1, 1], max: null }, themes: ["dark"] };
  validateSkinManifest(placeholder, shape);
  const metadata = entries.find(entry => entry.name.toLowerCase() === "manifest.json");
  ensure(metadata && metadata.size <= MAX_MANIFEST, "manifest missing or too large");
  let manifest;
  try { manifest = JSON.parse(decoder.decode(unpackEntry(bytes, metadata))); }
  catch { throw new Error("invalid manifest"); }
  const info = validateSkinManifest(manifest, shape);
  ensure(manifest.api.major === 1, "unsupported API major version");
  const files = new Map();
  for (const entry of entries) if (!entry.isDirectory) files.set(entry.name, unpackEntry(bytes, entry));
  return { manifest, info, files };
}
