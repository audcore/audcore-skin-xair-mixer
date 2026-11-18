// The native layer stays opaque until the actual interface and fonts have
// rendered. Showing the browser behind the cover comes before animation frames.
export async function revealNativeCover({ post, stateReady, fontsReady, pageReady = Promise.resolve(), frame = requestAnimationFrame, signal }) {
  if (typeof post !== "function" || typeof frame !== "function") throw new TypeError("invalid startup bridge");
  const ready = Promise.all([stateReady, fontsReady, pageReady]);
  // Readiness may reject after cancellation or a transport failure.
  ready.catch(() => {});
  if (signal?.aborted) {
    post({ version: 1, type: "startup", phase: "failed" });
    throw signal.reason ?? new Error("startup aborted");
  }
  post({ version: 1, type: "startup", phase: "show" });
  let onAbort;
  const aborted = signal && new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("startup aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  const wait = promise => aborted ? Promise.race([promise, aborted]) : promise;
  try {
    await wait(ready);
    await wait(new Promise(resolve => frame(resolve)));
    await wait(new Promise(resolve => frame(resolve)));
    post({ version: 1, type: "startup", phase: "complete" });
  } catch (error) {
    post({ version: 1, type: "startup", phase: "failed" });
    throw error;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
