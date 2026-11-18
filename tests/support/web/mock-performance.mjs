// Sample values only: no audio engine or process statistics are read here.
export function mockPerformance(graph) {
  const plugins = (graph?.chains ?? []).flatMap(chain => (chain.rack ?? []).map(slot => {
    const value = slot.offline ? 0 : (slot.instance % 15 + 1) / 10;
    return { instance: slot.instance, channel: chain.name || `通道 ${chain.id + 1}`, name: slot.alias || slot.name || slot.path, offline: !!slot.offline, bypass: !!slot.bypass, cpu_percent: value, mean_us: value * 10, peak_us: value * 15, deviation_us: value * 2 };
  }));
  return { simulated: true, sample_rate: graph?.sample_rate ?? 0, buffer_frames: graph?.buffer_frames ?? 0, total: { cpu_percent: plugins.reduce((sum, item) => sum + item.cpu_percent, 0) }, plugins };
}

// Browser mock host panel; WebView2 delegates to its C++ host instead.
export function createPreviewPerformance(document) {
  let dismiss = null;
  function open(report, t) {
    dismiss?.();
    return new Promise(resolve => {
      const previousFocus = document.activeElement;
      const overlay = document.createElement("div");
      overlay.className = "preview-overlay";
      const panel = document.createElement("div");
      panel.className = "preview-performance";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-label", t("性能"));
      const title = document.createElement("strong");
      title.textContent = `${t("性能")} · ${t("skin.mock_data")}`;
      const summary = document.createElement("div");
      summary.textContent = `CPU ${report.total.cpu_percent.toFixed(1)}% · ${report.sample_rate} Hz · ${report.buffer_frames} · ${t("skin.mean")} / ${t("峰值")} / ${t("skin.deviation")} (µs)`;
      const controls = document.createElement("div");
      const cpu = document.createElement("button");
      const deviation = document.createElement("button");
      const close = document.createElement("button");
      cpu.type = deviation.type = close.type = "button";
      cpu.textContent = "CPU";
      deviation.textContent = t("skin.deviation");
      close.textContent = t("关闭");
      const list = document.createElement("div");
      list.className = "preview-performance-results";
      let done = false;
      function finish() {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", keyboard, true);
        overlay.remove();
        if (previousFocus?.isConnected) previousFocus.focus();
        if (dismiss === finish) dismiss = null;
        resolve();
      }
      function keyboard(event) { if (event.key === "Escape") { event.preventDefault(); finish(); } }
      function render(key) {
        cpu.setAttribute("aria-pressed", String(key === "cpu_percent"));
        deviation.setAttribute("aria-pressed", String(key === "deviation_us"));
        list.replaceChildren(...[...report.plugins].sort((a, b) => b[key] - a[key]).map(item => {
          const row = document.createElement("div");
          const state = item.offline ? ` · ${t("离线")}` : item.bypass ? ` · ${t("旁通")}` : "";
          row.textContent = `${item.channel} / ${item.name}${state} · ${item.cpu_percent.toFixed(1)}% · ${item.mean_us.toFixed(1)} / ${item.peak_us.toFixed(1)} / ${item.deviation_us.toFixed(1)} µs`;
          return row;
        }));
      }
      cpu.addEventListener("click", () => render("cpu_percent"));
      deviation.addEventListener("click", () => render("deviation_us"));
      close.addEventListener("click", finish);
      overlay.addEventListener("pointerdown", event => { if (event.target === overlay) finish(); });
      document.addEventListener("keydown", keyboard, true);
      controls.append(cpu, deviation);
      panel.append(title, summary, controls, list, close);
      overlay.append(panel);
      document.body.append(overlay);
      dismiss = finish;
      render("cpu_percent");
      close.focus();
    });
  }
  open.close = () => dismiss?.();
  return open;
}
