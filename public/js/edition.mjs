// Which Stele this is. The computer edition talks to its Node server; the
// phone edition (published as plain files, scripts/build-phone.mjs) has no
// server and answers /api/… inside the page (phone/engine.mjs). The build
// marks it on <html data-edition="phone">, so CSS can hide what needs a
// computer before anything paints.
export const IS_PHONE = globalThis.document?.documentElement?.dataset?.edition === "phone";
