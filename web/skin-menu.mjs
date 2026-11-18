// In-page menu renderer. Menu data and validated actions come from the host.
export function createSkinMenu(document, view) {
  let dismiss = null;
  function show({ anchor, items }) {
    dismiss?.();
    return new Promise(resolve => {
      const menu = document.createElement("div");
      menu.className = "preview-menu";
      menu.setAttribute("role", "menu");
      let done = false;
      function finish(choice = null) {
        if (done) return;
        done = true;
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("keydown", keyboard, true);
        menu.remove();
        if (dismiss === cancel) dismiss = null;
        resolve(choice);
      }
      function cancel() { finish(); }
      function outside(event) { if (!menu.contains(event.target)) finish(); }
      function keyboard(event) {
        if (event.key === "Escape") { event.preventDefault(); finish(); }
      }
      function populate(container, entries, owner = null) {
        let child = null;
        const buttons = [];
        for (const item of entries) {
          const button = document.createElement("button");
          button.type = "button";
          buttons.push(button);
          button.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemcheckbox");
          button.disabled = !!item.disabled;
          if (item.checked !== undefined) button.setAttribute("aria-checked", String(item.checked));
          button.textContent = `${item.checked ? "✓ " : ""}${item.label}${item.children ? " ›" : ""}`;
          button.addEventListener("keydown", event => {
            if (event.key === "ArrowLeft" && owner) {
              event.preventDefault();
              container.remove();
              owner.setAttribute("aria-expanded", "false");
              owner.focus();
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const enabled = buttons.filter(item => !item.disabled);
            if (!enabled.length) return;
            const index = enabled.indexOf(button);
            const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 :
              (index + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
            event.preventDefault();
            enabled[next].focus();
          });
          if (item.children) {
            button.setAttribute("aria-haspopup", "menu");
            button.setAttribute("aria-expanded", "false");
            function open(focus) {
              if (!child || child.owner !== button || child.owner.getAttribute("aria-expanded") !== "true") {
                if (child) { child.element.remove(); child.owner.setAttribute("aria-expanded", "false"); }
                const submenu = document.createElement("div");
                submenu.className = "preview-menu";
                submenu.setAttribute("role", "menu");
                populate(submenu, item.children, button);
                container.append(submenu);
                const rect = button.getBoundingClientRect();
                const x = rect.right + submenu.offsetWidth <= view.innerWidth ? rect.right : rect.left - submenu.offsetWidth;
                submenu.style.left = `${Math.max(0, x)}px`;
                submenu.style.top = `${Math.max(0, Math.min(rect.top, view.innerHeight - submenu.offsetHeight))}px`;
                button.setAttribute("aria-expanded", "true");
                child = { element: submenu, owner: button };
              }
              if (focus) [...child.element.children].find(item => !item.disabled)?.focus();
            }
            button.addEventListener("pointerenter", () => open(false));
            button.addEventListener("click", () => open(true));
            button.addEventListener("keydown", event => { if (event.key === "ArrowRight") { event.preventDefault(); open(true); } });
          } else {
            button.addEventListener("pointerenter", () => { if (child) { child.element.remove(); child.owner.setAttribute("aria-expanded", "false"); child = null; } });
            button.addEventListener("click", () => finish(item.id));
          }
          container.append(button);
        }
      }
      populate(menu, items);
      document.body.append(menu);
      menu.style.left = `${Math.max(0, Math.min(anchor.x, view.innerWidth - menu.offsetWidth))}px`;
      menu.style.top = `${Math.max(0, Math.min(anchor.y, view.innerHeight - menu.offsetHeight))}px`;
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", keyboard, true);
      dismiss = cancel;
      [...menu.children].find(item => !item.disabled)?.focus();
    });
  }
  show.close = () => dismiss?.();
  return show;
}
