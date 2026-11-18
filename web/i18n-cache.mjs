// Cache is updated only from host state. Names, paths and user data are never
// translated; missing public keys are returned verbatim for clear diagnosis.
export function createI18nCache() {
  let language = null;
  let messages = Object.create(null);
  return Object.freeze({
    update(value) {
      if (!value || typeof value.language !== "string" || !value.messages || typeof value.messages !== "object" || Array.isArray(value.messages)) return false;
      const next = Object.create(null);
      for (const [key, text] of Object.entries(value.messages)) {
        if (typeof text === "string") next[key] = text;
      }
      language = value.language;
      messages = next;
      return true;
    },
    getLanguage() { return language; },
    t(key) { return typeof key === "string" ? messages[key] ?? key : ""; },
    clear() { language = null; messages = Object.create(null); }
  });
}
