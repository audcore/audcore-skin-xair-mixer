// The host owns sleep and delivery. The skin keeps its subscription until teardown.
export function mountMeters(host, _visibility, render, onError = error => console.error(error), { loudness = false } = {}) {
  let disposed = false;
  let stop = null;
  let desired = loudness;
  let applied = loudness;
  let changing = false;
  let demandRevision = 0;
  let subscribing = false;
  let attempt = 0;
  async function sync() {
    if (disposed || !stop || changing || desired === applied) return;
    changing = true;
    const started = demandRevision;
    try {
      while (!disposed && desired !== applied) {
        const next = desired;
        await host.meters.setLoudness(next);
        applied = next;
      }
    } catch (error) { if (!disposed) onError(error); }
    finally {
      changing = false;
      if (!disposed && demandRevision !== started && desired !== applied) void sync();
    }
  }
  function subscribe() {
    if (disposed || stop || subscribing) return;
    subscribing = true;
    const current = ++attempt;
    const started = demandRevision;
    const requested = desired;
    const failed = error => {
      subscribing = false;
      if (current === attempt) ++attempt;
      if (!disposed) onError(error);
      // A resume snapshot may have arrived while the failed request was in
      // flight. Retry once for that event, never on a timer or in a loop.
      if (!disposed && demandRevision !== started) subscribe();
    };
    let pending;
    try {
      pending = host.meters.subscribe(frame => {
        if (!disposed && current === attempt) render(frame);
      }, { loudness: requested });
    } catch (error) { failed(error); return; }
    Promise.resolve(pending).then(release => {
      subscribing = false;
      if (disposed || current !== attempt) release();
      else { stop = release; applied = requested; void sync(); }
    }, failed);
  }
  subscribe();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ++attempt;
    if (stop) { stop(); stop = null; }
  };
  dispose.setLoudness = enabled => { desired = Boolean(enabled); demandRevision++; if (stop) void sync(); else subscribe(); };
  return dispose;
}
