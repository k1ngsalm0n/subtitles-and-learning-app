// A dropdown with a search box: a trigger button that opens a short, scrolling
// list, filtered as you type. Same shape as the card-type picker (a button
// plus a list, positioned under it), for lists long enough that reading every
// row to find one is the slow part — chat providers, a machine's pulled models.
//
// Items are { value, label, detail?, tag? }. The search matches label and
// detail, case-insensitively, and the list keeps their order.
//
// Lives inside <dialog>s, so Escape closes the list rather than the dialog,
// and Enter picks a row rather than submitting the form.

let counter = 0;

export function createCombobox(root, { label, placeholder = "Search…", onChange } = {}) {
  const id = `combo${++counter}`;
  root.classList.add("combo");
  root.innerHTML = `
    <button type="button" class="combo-trigger" aria-haspopup="listbox"
      aria-expanded="false" aria-label="${label}">
      <span class="combo-current"></span>
    </button>
    <div class="combo-panel" hidden>
      <input type="search" class="combo-search" placeholder="${placeholder}"
        role="combobox" aria-expanded="true" aria-autocomplete="list"
        aria-controls="${id}-list" aria-label="Search ${label}"
        autocomplete="off" spellcheck="false" />
      <div class="combo-list" id="${id}-list" role="listbox" aria-label="${label}"></div>
      <p class="combo-empty muted" hidden>No matches.</p>
    </div>`;

  const trigger = root.querySelector(".combo-trigger");
  const current = root.querySelector(".combo-current");
  const panel = root.querySelector(".combo-panel");
  const search = root.querySelector(".combo-search");
  const list = root.querySelector(".combo-list");
  const empty = root.querySelector(".combo-empty");

  let items = [];
  let value = "";
  let shown = []; // the items passing the current search, in list order
  let active = -1; // index into `shown` that the arrow keys are on

  function find(v) {
    return items.find((item) => item.value === v);
  }

  function paintTrigger() {
    const item = find(value);
    current.textContent = "";
    if (!item) return;
    const name = document.createElement("strong");
    name.textContent = item.label;
    current.append(name);
    if (item.tag) {
      const tag = document.createElement("span");
      tag.className = "combo-tag";
      tag.textContent = item.tag;
      current.append(" ", tag);
    }
  }

  function renderList() {
    const query = search.value.trim().toLowerCase();
    shown = items.filter((item) =>
      !query ||
      item.label.toLowerCase().includes(query) ||
      (item.detail || "").toLowerCase().includes(query),
    );
    list.textContent = "";
    shown.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "combo-option";
      row.id = `${id}-opt${i}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(item.value === value));
      row.dataset.index = String(i);

      const name = document.createElement("span");
      name.className = "combo-option-name";
      name.textContent = item.label;
      if (item.tag) {
        const tag = document.createElement("span");
        tag.className = "combo-tag";
        tag.textContent = item.tag;
        name.append(" ", tag);
      }
      row.append(name);
      if (item.detail) {
        const detail = document.createElement("span");
        detail.className = "combo-option-detail muted";
        detail.textContent = item.detail;
        row.append(detail);
      }
      list.append(row);
    });
    empty.hidden = shown.length > 0;
    // Start on the chosen row when it survived the filter, else the first.
    const chosen = shown.findIndex((item) => item.value === value);
    setActive(query ? 0 : Math.max(chosen, 0));
  }

  function setActive(i) {
    active = shown.length ? Math.min(Math.max(i, 0), shown.length - 1) : -1;
    list.querySelectorAll(".combo-option").forEach((row, n) => {
      row.classList.toggle("active", n === active);
    });
    const row = active >= 0 ? list.children[active] : null;
    if (row) {
      search.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView({ block: "nearest" });
    } else {
      search.removeAttribute("aria-activedescendant");
    }
  }

  function open(on) {
    if (on && trigger.disabled) return;
    panel.hidden = !on;
    trigger.setAttribute("aria-expanded", String(on));
    if (on) {
      search.value = "";
      renderList();
      search.focus();
    }
  }

  function pick(item) {
    open(false);
    trigger.focus();
    if (!item || item.value === value) return;
    value = item.value;
    paintTrigger();
    onChange?.(value);
  }

  trigger.addEventListener("click", () => open(panel.hidden));
  search.addEventListener("input", renderList);
  list.addEventListener("click", (event) => {
    const row = event.target.closest(".combo-option");
    if (row) pick(shown[Number(row.dataset.index)]);
  });
  // Keep the mouse and the arrow keys pointing at the same row.
  list.addEventListener("mousemove", (event) => {
    const row = event.target.closest(".combo-option");
    if (row && Number(row.dataset.index) !== active) setActive(Number(row.dataset.index));
  });

  root.addEventListener("keydown", (event) => {
    if (panel.hidden) {
      if (event.target === trigger && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        open(true);
      }
      return;
    }
    if (event.key === "Escape") {
      // Close the list, not the <dialog> around it.
      event.preventDefault();
      event.stopPropagation();
      open(false);
      trigger.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(active + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(active - 1);
    } else if (event.key === "Home" && event.target !== search) {
      setActive(0);
    } else if (event.key === "Enter") {
      // Pick a row rather than submit the form the list sits in.
      event.preventDefault();
      if (active >= 0) pick(shown[active]);
    } else if (event.key === "Tab") {
      open(false);
    }
  });

  // Clicking anywhere else closes it.
  document.addEventListener("pointerdown", (event) => {
    if (!panel.hidden && !root.contains(event.target)) open(false);
  });

  return {
    get value() {
      return value;
    },
    // Doesn't fire onChange: the caller is setting it, so it already knows.
    set value(v) {
      value = v;
      paintTrigger();
    },
    setItems(next) {
      items = next;
      if (!find(value)) value = items[0]?.value ?? "";
      paintTrigger();
      if (!panel.hidden) renderList();
    },
    set disabled(on) {
      trigger.disabled = on;
      if (on) open(false);
    },
    close() {
      open(false);
    },
  };
}
