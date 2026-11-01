// Port 3001 is a separate origin; namespacing also prevents reading copied stable keys.
export const DEV_STORAGE_PREFIX = "hymet-v1:";
export function scopedStorage(storage: Storage): Storage {
  const keys = () =>
    Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(
      (k): k is string => !!k && k.startsWith(DEV_STORAGE_PREFIX),
    );
  return {
    get length() {
      return keys().length;
    },
    key: (i) => keys()[i]?.slice(DEV_STORAGE_PREFIX.length) ?? null,
    getItem: (k) => storage.getItem(DEV_STORAGE_PREFIX + k),
    setItem: (k, v) => storage.setItem(DEV_STORAGE_PREFIX + k, v),
    removeItem: (k) => storage.removeItem(DEV_STORAGE_PREFIX + k),
    clear: () => {
      for (const key of keys()) storage.removeItem(key);
    },
  };
}
export function developmentStorage() {
  return scopedStorage(window.localStorage);
}
