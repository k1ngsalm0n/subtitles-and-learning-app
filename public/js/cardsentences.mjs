// New sentences for cards that are close to Recall (carddata.mjs), asked
// for in the background, one card at a time, and kept on the card
// (`sentences`, `sentencesAt`) so each card costs one chat-model request,
// ever. Only cards a review or two away from Recall — a Fill in the blank
// card, or a Recognise card already spaced SOON_DAYS apart — so a deck of 500
// new cards doesn't spend a free plan's day at once.

import { BUILTIN_TEMPLATE_IDS, wantsSentences } from "./carddata.mjs";

export const SOON_DAYS = 3;
const PER_SESSION = 20;

export function sentencesSoon(card) {
  if (!wantsSentences(card)) return false;
  if (card.templateId === BUILTIN_TEMPLATE_IDS.cloze) return true;
  return card.state === "review" && (card.interval || 0) >= SOON_DAYS;
}

let asked = 0;

// post(body) → the server's { sentences, reason } (or null). Returns how many
// cards changed. Stops at the first card the chat model couldn't answer for:
// it's down or not set up, and the next session can try again.
export async function fillSentences(cards, { post, known = [], onChange = () => {} }) {
  let changed = 0;
  for (const card of cards.filter(sentencesSoon)) {
    if (asked >= PER_SESSION) break;
    asked++;
    const reply = await post({
      word: card.word,
      pinyin: card.pinyin || "",
      meaning: card.translation || "",
      example: card.example || "",
      known,
    }).catch(() => null);
    if (!reply || (!reply.sentences?.length && reply.reason !== "none passed the checks")) break;
    card.sentences = reply.sentences;
    card.sentencesAt = Date.now();
    changed++;
    onChange(card);
  }
  return changed;
}
