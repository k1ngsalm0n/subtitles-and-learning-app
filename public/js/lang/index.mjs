// Language provider registry. Each provider implements segment(text) -> [{text,isWord}].
// Spaceless languages share the Intl.Segmenter factory; everything else uses
// the space/punctuation splitter. To support a new spaceless language, add its
// code to SEGMENTED — the UI and lookup stay unchanged.
import { generic } from "./generic.mjs";
import { makeSegmentedProvider } from "./segmented.mjs";

const SEGMENTED = ["zh", "ja", "ko", "th"];
const cache = new Map();

export function getProvider(lang) {
  if (!SEGMENTED.includes(lang)) return generic;
  if (!cache.has(lang)) cache.set(lang, makeSegmentedProvider(lang));
  return cache.get(lang);
}
