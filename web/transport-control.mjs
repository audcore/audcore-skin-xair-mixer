// Only one request waits for completion at a time. Extra clicks are kept as
// parity so an arbitrary burst cannot grow an unbounded command queue.
export function createTransportControl(send, onError) {
  let playing = null;
  let target = null;
  let queued = false;
  let generation = 0;

  function cancel() {
    generation++;
    playing = null;
    target = null;
    queued = false;
  }
  function start() {
    if (playing === null || target !== null) return;
    target = !playing;
    const current = ++generation;
    try {
      const requested = target;
      Promise.resolve(send(requested)).then(() => {
        if (generation !== current) return;
        playing = requested;
        target = null;
        generation++;
        if (queued) { queued = false; start(); }
      }, error => fail(current, error));
    } catch (error) {
      fail(current, error);
    }
  }
  function fail(current, error) {
    if (generation !== current) return;
    generation++;
    target = null;
    queued = false;
    onError(error);
  }
  return Object.freeze({
    update(value, snapshot = false) {
      if (snapshot) cancel();
      playing = typeof value === "boolean" ? value : null;
      if (playing === null) { cancel(); return; }
    },
    toggle() {
      if (playing === null) return;
      if (target !== null) queued = !queued;
      else start();
    },
    cancel,
  });
}
