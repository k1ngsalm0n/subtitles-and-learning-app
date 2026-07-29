// Bottom-center toast notifications with optional action buttons
// ("Added to Deck · Undo · Edit…"). One at a time — a new toast replaces the
// previous one.

let _container = null;
let _current = null;

function getContainer() {
  if (!_container) {
    _container = document.createElement("div");
    _container.className = "toast-container";
    document.body.appendChild(_container);
  }
  return _container;
}

export function showToast(message, { actions = [], duration = 6000 } = {}) {
  _current?.();
  const toast = document.createElement("div");
  toast.className = "toast";
  const text = document.createElement("span");
  text.textContent = message;
  toast.appendChild(text);

  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    toast.remove();
    if (_current === dismiss) _current = null;
  };
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      dismiss();
      action.onClick?.();
    });
    toast.appendChild(button);
  }

  getContainer().appendChild(toast);
  timer = setTimeout(dismiss, duration);
  _current = dismiss;
  return dismiss;
}
