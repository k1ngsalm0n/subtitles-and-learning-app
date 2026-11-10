// Installing Stele to a home screen: registers the service worker (sw.js) that
// lets it open with no connection. The manifest and icons are in index.html's
// <head>.
//
// Browsers only allow a service worker in a secure context — https, or
// localhost — so a phone reaching this machine over plain http on the LAN
// simply doesn't get one; Tailscale's https address does. Registration never
// blocks anything: a failure leaves the app exactly as it was.

export function registerServiceWorker({ nav = globalThis.navigator, secure = globalThis.isSecureContext } = {}) {
  if (!secure || !nav?.serviceWorker?.register) return Promise.resolve(null);
  return nav.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => null);
}
