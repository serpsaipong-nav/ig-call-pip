// Toolbar popup: start or stop Loop call without opening the chat.
const KEY = "igLoop";
const $ = (id) => document.getElementById(id);

const render = (s) => {
  const ready = !!s.callUrl;
  $("loop").hidden = false;
  $("call").disabled = !ready;
  $("call").textContent = s.on ? "Stop loop call" : "Call her";
  $("call").classList.toggle("stop", !!s.on);
  $("hint").textContent = !ready
    ? "Call her once from the chat first, so the extension learns her call address."
    : s.on
      ? `Loop call is on · ${s.attempts || 0} dialed`
      : "Opens her call in a new window and keeps calling until she picks up.";
};

chrome.storage.local.get(KEY, (o) => render(o[KEY] || {}));

$("call").addEventListener("click", () => {
  chrome.storage.local.get(KEY, (o) => {
    const s = o[KEY] || {};
    if (s.on) {
      chrome.storage.local.set({ [KEY]: { ...s, on: false } }, () => render({ ...s, on: false }));
      return;
    }
    if (!s.callUrl) return;
    const next = { ...s, on: true, attempts: 0, lastAlive: Date.now(), lastDial: Date.now() };
    chrome.storage.local.set({ [KEY]: next }, () => {
      chrome.windows.create({ url: s.callUrl, type: "popup", width: 960, height: 640 });
      window.close();
    });
  });
});
