// The host owns the HWND; a skin only requests window operations.
export function bindWindowControls({ toolbar, drag, footer, workspace, channels, minimize, maximize, close, resizeAreas, api, onError }) {
  const run = operation => Promise.resolve().then(operation).catch(onError);
  const onHeader = event => event.target === toolbar || event.target === drag;
  if (footer) {
    // Native window dragging takes over mouse capture, so wait for motion before
    // requesting it and leave clicks available to the WebView's dblclick event.
    const bindDrag = (region, accepts) => {
      let start;
      let dragged = false;
      region.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        dragged = false;
        if (!accepts(event)) return;
        start = event;
        event.target.setPointerCapture(event.pointerId);
      });
      region.addEventListener("pointermove", event => {
        if (!start || event.pointerId !== start.pointerId ||
            Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 4) return;
        start = null;
        dragged = true;
        run(() => api.startDrag());
      });
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
        region.addEventListener(type, event => {
          if (event.pointerId === start?.pointerId) start = null;
        });
      }
      region.addEventListener("click", event => {
        if (!dragged || event.detail === 0) return;
        dragged = false;
        event.preventDefault();
        event.stopPropagation();
      }, true);
    };
    const barSurface = event => !event.target.closest("input, #table-search-box");
    bindDrag(toolbar, barSurface);
    bindDrag(footer, barSurface);
    if (workspace) bindDrag(workspace, event => event.target === workspace || event.target === channels);
    toolbar.addEventListener("dblclick", event => {
      if (event.button === 0 && onHeader(event)) run(() => api.toggleMaximize());
    });
  } else {
    toolbar.addEventListener("pointerdown", event => {
      if (event.button === 0 && onHeader(event)) run(() => api.startDrag());
    });
  }
  minimize.addEventListener("click", () => run(() => api.minimize()));
  maximize.addEventListener("click", () => run(() => api.toggleMaximize()));
  close.addEventListener("click", () => run(() => api.close()));
  for (const area of resizeAreas) {
    area.addEventListener("pointerdown", event => {
      if (event.button === 0) run(() => api.startResize(area.getAttribute("data-resize")));
    });
  }
}
