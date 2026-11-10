// Imported first by main.mjs: on the phone edition, every /api/… request is
// answered inside the page from here on. It has to come before any module
// that asks the server something as it loads (tts.mjs asks for voices).
import { IS_PHONE } from "../edition.mjs";
import { useEngine } from "../backend.mjs";
import { createEngine } from "./engine.mjs";
import { indexedDbStore, memoryStore, localSettings } from "./store.mjs";

if (IS_PHONE) {
  useEngine(
    createEngine({
      store: globalThis.indexedDB ? indexedDbStore() : memoryStore(),
      settings: localSettings(),
    }),
  );
}
