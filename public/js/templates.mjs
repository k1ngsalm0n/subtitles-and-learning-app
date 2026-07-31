// Card templates: stored, reusable objects describing which fields appear on
// each face. Three built-ins are seeded by state.mjs and can't be edited or
// deleted; custom templates are created/edited here. One template is the
// default — it drives the quick-add path.

import {
  state,
  saveTemplates,
  setDefaultTemplate,
  getTemplate,
} from "./state.mjs";
import {
  CARD_FIELDS,
  validateTemplate,
  isAudioField,
  BUILTIN_TEMPLATE_IDS,
} from "./carddata.mjs";
import { ttsAvailable, onVoicesChanged } from "./tts.mjs";
import { escapeHtml } from "./util.mjs";

// ---- CRUD -------------------------------------------------------------------

// Insert or update a custom template. Returns an error message or null.
export function upsertTemplate(template) {
  const error = validateTemplate(template, state.templates);
  if (error) return error;
  const existing = getTemplate(template.id);
  if (existing?.builtIn) return "Built-in templates can't be edited.";
  const clean = {
    id: template.id || `tpl-${crypto.randomUUID()}`,
    name: template.name.trim(),
    frontFields: [...template.frontFields],
    backFields: [...template.backFields],
    showStrokes: Boolean(template.showStrokes),
    builtIn: false,
  };
  const index = state.templates.findIndex((tpl) => tpl.id === clean.id);
  if (index === -1) state.templates.push(clean);
  else state.templates[index] = clean;
  saveTemplates();
  return null;
}

// Deleting a template leaves existing cards intact — they carry their own
// copies of the field lists.
export function deleteTemplate(id) {
  const template = getTemplate(id);
  if (!template || template.builtIn) return;
  state.templates = state.templates.filter((tpl) => tpl.id !== id);
  if (state.defaultTemplateId === id) {
    setDefaultTemplate(BUILTIN_TEMPLATE_IDS.default);
  }
  saveTemplates();
}

// ---- Template editor dialog -------------------------------------------------

let _editorEls = null;
let _editing = null; // template id being edited, or null for a new one
let _onSaved = null;

function fieldCheckboxes(side) {
  return CARD_FIELDS.map((field) => {
    const audio = isAudioField(field.key);
    return `<label class="tpl-field${audio ? " tpl-field-audio" : ""}">
      <input type="checkbox" data-side="${side}" value="${field.key}" />
      <span>${escapeHtml(field.label)}</span>
    </label>`;
  }).join("");
}

// Audio fields need a speechSynthesis voice for the learning language; when
// there is none the checkboxes are disabled with an explanation, so templates
// can't promise sound the machine can't make.
function syncAudioAvailability(els) {
  const available = ttsAvailable(state.learningLang);
  els.templateDialog
    .querySelectorAll(".tpl-field-audio input")
    .forEach((box) => {
      box.disabled = !available;
      if (!available) box.checked = false;
    });
  els.templateDialog.querySelectorAll(".tpl-field-audio").forEach((label) => {
    label.classList.toggle("disabled", !available);
    label.title = available
      ? ""
      : "No text-to-speech voice for this language is installed in your browser/OS.";
  });
}

export function setupTemplateEditor(els) {
  _editorEls = els;
  els.tplFrontFields.innerHTML = fieldCheckboxes("front");
  els.tplBackFields.innerHTML = fieldCheckboxes("back");
  onVoicesChanged(() => {
    if (els.templateDialog.open) syncAudioAvailability(els);
  });

  const revalidate = () => {
    els.tplError.textContent = "";
    els.tplSave.disabled = Boolean(validateTemplate(readEditor(els), state.templates));
  };
  els.templateDialog.addEventListener("input", revalidate);

  els.tplSave.addEventListener("click", () => {
    const draft = readEditor(els);
    const error = upsertTemplate(draft);
    if (error) {
      els.tplError.textContent = error;
      return;
    }
    els.templateDialog.close();
    const saved =
      getTemplate(draft.id) ||
      state.templates.find((tpl) => tpl.name === draft.name.trim());
    _onSaved?.(saved);
  });
}

function readEditor(els) {
  const picked = (side) =>
    [...els.templateDialog.querySelectorAll(`input[data-side="${side}"]:checked`)]
      .map((box) => box.value);
  return {
    id: _editing,
    name: els.tplName.value,
    frontFields: picked("front"),
    backFields: picked("back"),
    showStrokes: els.tplStrokes.checked,
  };
}

export function openTemplateEditor(templateId, onSaved) {
  const els = _editorEls;
  const template = templateId ? getTemplate(templateId) : null;
  if (template?.builtIn) return;
  _editing = template?.id || null;
  _onSaved = onSaved || null;

  els.tplEditorTitle.textContent = template ? "Edit template" : "New template";
  els.tplName.value = template?.name || "";
  els.tplStrokes.checked = Boolean(template?.showStrokes);
  els.templateDialog.querySelectorAll("input[data-side]").forEach((box) => {
    const list =
      box.dataset.side === "front"
        ? template?.frontFields
        : template?.backFields;
    box.checked = Boolean(list?.includes(box.value));
  });
  syncAudioAvailability(els);
  els.tplError.textContent = "";
  els.tplSave.disabled = Boolean(validateTemplate(readEditor(els), state.templates));
  els.templateDialog.showModal();
  els.tplName.focus();
}

// ---- Template manager dialog ------------------------------------------------

let _managerEls = null;
let _onChanged = null;

export function setupTemplateManager(els, onChanged) {
  _managerEls = els;
  _onChanged = onChanged || null;

  els.manageTemplates.addEventListener("click", () => {
    renderManager(els);
    els.templatesDialog.showModal();
  });
  els.newTemplate.addEventListener("click", () => {
    openTemplateEditor(null, () => {
      renderManager(els);
      _onChanged?.();
    });
  });

  els.templatesList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const id = button.dataset.id;
    if (button.dataset.action === "default") {
      setDefaultTemplate(id);
    } else if (button.dataset.action === "edit") {
      openTemplateEditor(id, () => {
        renderManager(els);
        _onChanged?.();
      });
      return;
    } else if (button.dataset.action === "delete") {
      const template = getTemplate(id);
      if (
        template &&
        confirm(
          `Delete template "${template.name}"? Existing cards keep their fields.`,
        )
      ) {
        deleteTemplate(id);
      }
    }
    renderManager(els);
    _onChanged?.();
  });
}

function describeTemplate(template) {
  const label = (keys) =>
    keys
      .map((key) => CARD_FIELDS.find((field) => field.key === key)?.label || key)
      .join(", ");
  const strokes = template.showStrokes ? " · stroke order on the back" : "";
  return `Front: ${label(template.frontFields)} — Back: ${label(template.backFields)}${strokes}`;
}

function renderManager(els) {
  els.templatesList.innerHTML = state.templates
    .map((template) => {
      const isDefault = template.id === state.defaultTemplateId;
      return `<article class="tpl-item">
        <div class="tpl-item-body">
          <strong>${escapeHtml(template.name)}</strong>
          ${isDefault ? '<span class="tpl-badge tpl-badge-default">default</span>' : ""}
          ${template.builtIn ? '<span class="tpl-badge">built-in</span>' : ""}
          <p class="muted">${escapeHtml(describeTemplate(template))}</p>
        </div>
        <div class="tpl-item-actions">
          ${isDefault ? "" : `<button type="button" data-action="default" data-id="${template.id}">Make default</button>`}
          ${template.builtIn ? "" : `<button type="button" data-action="edit" data-id="${template.id}">Edit</button>`}
          ${template.builtIn ? "" : `<button type="button" data-action="delete" data-id="${template.id}" class="danger">Delete</button>`}
        </div>
      </article>`;
    })
    .join("");
}
