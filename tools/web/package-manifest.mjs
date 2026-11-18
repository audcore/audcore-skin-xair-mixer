// Draft validation for a pre-enumerated archive. The caller must independently
// verify compressed bytes, encryption, CRC, expansion limits and extracted data.
const MAX_FILES = 4096;
const MAX_FILE_SIZE = 64 * 1024 * 1024;
const MAX_TOTAL_SIZE = 128 * 1024 * 1024;
const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

function resourcePath(value, directory = false) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 ||
      value.includes("\\") || value.startsWith("/") || /[\u0000-\u001f\u007f-\u009f:*?"<>|%#]/.test(value)) {
    throw new Error("invalid package path");
  }
  const path = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  const segments = path.split("/");
  if (segments.some(segment => !segment || segment.length > 255 || segment === "." || segment === ".." ||
      segment.endsWith(".") || segment.endsWith(" ") || RESERVED.test(segment))) {
    throw new Error("invalid package path segment");
  }
  return path;
}

function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 10000;
}

function sizePair(value) {
  return Array.isArray(value) && value.length === 2 && value.every(positive);
}

export function validateSkinNames(names) {
  if (!names || typeof names !== "object" || Array.isArray(names) ||
      Object.entries(names).some(([language, name]) => !["zh", "en", "ja"].includes(language) ||
        typeof name !== "string" || !name.trim() || name.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(name))) {
    throw new Error("invalid localized skin names");
  }
}

export function validateSkinManifest(manifest, entries) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("invalid manifest");
  if (typeof manifest.id !== "string" || manifest.id.length > 128 || !/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.id)) throw new Error("invalid skin id");
  resourcePath(manifest.id);
  if (typeof manifest.name !== "string" || !manifest.name.trim() || manifest.name.length > 128) throw new Error("invalid skin name");
  if (manifest.names !== undefined) validateSkinNames(manifest.names);
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("invalid skin version");
  if (!manifest.api || manifest.api.major !== 1 ||
      !Number.isSafeInteger(manifest.api.minor) || manifest.api.minor < 0) throw new Error("invalid api version");
  const entry = resourcePath(manifest.entry);
  if (!/\.html$/i.test(entry)) throw new Error("entry must be HTML");
  const window = manifest.window;
  if (!window || !sizePair(window.default) || !sizePair(window.min) ||
      !(window.max === null || sizePair(window.max))) throw new Error("invalid window dimensions");
  if ("title" in window && (typeof window.title !== "string" || !window.title.trim() ||
      window.title.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(window.title) ||
      window.title.replace(/\$\{(?:skinName|skinVersion|hostVersion)\}/g, "").includes("${"))) {
    throw new Error("invalid window title");
  }
  for (const key of ["resizable", "maximizable", "forceNativeFrame", "showVersions"]) {
    if (key in window && typeof window[key] !== "boolean") throw new Error("invalid window capability");
  }
  for (let i = 0; i < 2; i++) {
    if (window.default[i] < window.min[i] || (window.max && (window.max[i] < window.min[i] || window.default[i] > window.max[i]))) {
      throw new Error("inconsistent window dimensions");
    }
  }
  if (!Array.isArray(manifest.themes) || !manifest.themes.length ||
      manifest.themes.some(theme => theme !== "dark" && theme !== "light") || new Set(manifest.themes).size !== manifest.themes.length) {
    throw new Error("invalid themes");
  }
  if (manifest.scale !== undefined) {
    const { min, max, default: initial } = manifest.scale ?? {};
    if (![min, max, initial].every(value => typeof value === "number" && Number.isFinite(value)) || min < 0.25 || max > 4 || min > initial || initial > max) throw new Error("invalid scale");
  }
  if (manifest.languages !== undefined && (!Array.isArray(manifest.languages) ||
      manifest.languages.some(language => typeof language !== "string" || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language)))) {
    throw new Error("invalid languages");
  }
  if (!Array.isArray(entries) || entries.length > MAX_FILES) throw new Error("invalid archive entries");
  let total = 0;
  const paths = new Map();
  for (const item of entries) {
    if (!item || typeof item !== "object" || typeof item.isDirectory !== "boolean" || item.isSymlink !== false ||
        !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE_SIZE || (item.isDirectory && item.size !== 0)) {
      throw new Error("invalid archive entry");
    }
    const path = resourcePath(item.name, item.isDirectory);
    const key = path.normalize("NFC").toLowerCase();
    if (paths.has(key)) throw new Error("duplicate archive path");
    paths.set(key, item);
    total += item.size;
    if (total > MAX_TOTAL_SIZE) throw new Error("archive too large");
  }
  for (const [key] of paths) {
    const segments = key.split("/");
    for (let i = 1; i < segments.length; i++) {
      const parent = paths.get(segments.slice(0, i).join("/"));
      if (parent && !parent.isDirectory) throw new Error("archive file used as directory");
    }
  }
  const entryFile = paths.get(entry.normalize("NFC").toLowerCase());
  if (!entryFile || entryFile.isDirectory) throw new Error("entry not found");
  if ("icon" in window) {
    const icon = resourcePath(window.icon);
    const file = paths.get(icon.normalize("NFC").toLowerCase());
    if (!/\.ico$/i.test(icon) || !file || file.name !== icon || file.isDirectory || file.size === 0 || file.size > 1024 * 1024) {
      throw new Error("invalid window icon");
    }
  }
  return { id: manifest.id, entry, files: entries.length, uncompressedBytes: total };
}
