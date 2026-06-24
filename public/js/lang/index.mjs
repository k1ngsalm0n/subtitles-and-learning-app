// Language provider registry. Each provider implements segment(text) -> [{text,isWord}].
// To support a new language, add a module here — the UI and lookup stay unchanged.
import { generic } from "./generic.mjs";
import { zh } from "./zh.mjs";

const providers = {
  zh,
  // Japanese/Korean/Thai also work well with Intl.Segmenter; add modules as needed.
};

export function getProvider(lang) {
  return providers[lang] || generic;
}
