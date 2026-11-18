// Keep the latest requested value while host updates are still in flight.
export function createPendingToggles(onError) {
  const pending = new Map();
  return Object.freeze({
    toggle(key, actual, send) {
      const previous = pending.get(key);
      const request = { target: !(previous?.target ?? actual), observed: previous?.observed ?? actual };
      pending.set(key, request);
      try {
        Promise.resolve(send(request.target)).catch(error => {
          if (pending.get(key) !== request) return;
          pending.delete(key);
          onError(error);
        });
      } catch (error) {
        if (pending.get(key) === request) {
          pending.delete(key);
          onError(error);
        }
      }
    },
    update(key, actual, explicit = false) {
      const request = pending.get(key);
      if (!request) return;
      if (actual === request.target && (explicit || actual !== request.observed)) pending.delete(key);
      else request.observed = actual;
    },
    clear() { pending.clear(); },
  });
}
