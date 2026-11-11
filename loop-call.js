// Instagram Call PiP: Loop call.
// While Loop call is on, the DM thread it was turned on in calls her again whenever
// no call is open, so a dropped or unanswered call redials by itself.
(() => {
  if (window.__igLoopLoaded) return;
  window.__igLoopLoaded = true;

  const CALL_TYPE = "video";     // "video" or "audio"
  const HEARTBEAT_MS = 2000;     // a frame that's in a call reports this often
  const DEAD_AFTER_MS = 8000;    // no report for this long = no call is open
  const REDIAL_GAP_MS = 15000;   // minimum time between dial attempts (grows while she doesn't answer)
  const MAX_GAP_MS = 300000;     // backoff ceiling: Instagram answers too many calls with HTTP 429
  const KEY = "igLoop";          // { on, thread, lastAlive, lastDial, attempts, fails }
  // Gap before the next dial: 15s, 30s, 60s, ... up to 5 min after each unanswered call in a row.
  // Both dialers (call window and chat tab) use it, measured from the same lastDial.
  const gapFor = (s) => Math.min(REDIAL_GAP_MS * 2 ** Math.min(s.fails || 0, 10), MAX_GAP_MS);

  // After the extension is reloaded, this old copy can't reach it any more ("Extension context
  // invalidated"). It then stops itself and removes its pill; the fresh copy takes over.
  const timers = [];
  const alive = () => { try { return !!chrome.runtime?.id; } catch (_) { return false; } };
  const shutDown = () => {
    timers.forEach(clearInterval);
    document.getElementById("igloop-pill")?.remove();
  };

  const store = chrome.storage.local;
  const get = () => new Promise((r, reject) => {
    if (!alive()) return reject(new Error("gone"));
    try { store.get(KEY, (o) => r((o && o[KEY]) || {})); } catch (e) { reject(e); }
  });
  const patch = async (p) => {
    const s = { ...(await get()), ...p };
    await store.set({ [KEY]: s });
    return s;
  };
  // Runs fn on an interval; if the extension has gone away, shuts this copy down instead of erroring.
  const every = (ms, fn) => timers.push(setInterval(() => {
    if (!alive()) return shutDown();
    Promise.resolve().then(fn).catch(() => { if (!alive()) shutDown(); });
  }, ms));

  // ---------- Every frame: report "a call is open" ----------
  const liveMedia = () =>
    [...document.querySelectorAll("video, audio")].some((m) => {
      const s = m.srcObject;
      return s instanceof MediaStream && s.getTracks().some((t) => t.readyState === "live");
    });
  // Your own camera/mic are live while a call is ringing or connected (mic-hook.js reports them).
  const localLive = () => ["igpipMic", "igpipCam"].some((k) => {
    const v = document.documentElement.dataset[k];
    return v === "on" || v === "off";
  });
  const inCall = () => liveMedia() || localLive();

  const RING_TIMEOUT_MS = 90000;  // safety net only: normally Instagram stops ringing by itself first
  const DROP_TIMEOUT_MS = 30000;  // she was on, and her video/audio has been gone this long
  const ENDED_TEXT = /no answer|didn.t answer|not answering|unavailable|isn.t available|call ended|call failed|couldn.t connect|call again/i;

  // Her side: any live track on the page that isn't one of your own (mic-hook.js lists yours).
  const remoteLive = () => {
    const mine = new Set((document.documentElement.dataset.igpipLocal || "").split(",").filter(Boolean));
    return [...document.querySelectorAll("video, audio")].some((m) => {
      const s = m.srcObject;
      return s instanceof MediaStream &&
        s.getTracks().some((t) => t.readyState === "live" && !t.muted && !mine.has(t.id));
    });
  };

  const isCallWindow = location.pathname.startsWith("/call");
  const START_TEXT = /^start call$/i;   // only a fresh call rings her; "Join call" does not
  const END_LABEL = /end call|leave call|hang ?up|cancel call/i;
  const textOf = (b) => (b.getAttribute("aria-label") || b.innerText || b.textContent || "").trim();
  const buttons = () => [...document.querySelectorAll('button, [role="button"]')];
  const startButton = () => buttons().find((b) => START_TEXT.test(textOf(b)));
  const endButton = () => buttons().find((b) => { const t = textOf(b); return t.length <= 40 && END_LABEL.test(t); });
  const press = (b) => b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));

  let ringingSince = 0;    // when we pressed Start call
  let herLastSeen = 0;     // last time her video/audio was on
  let lastPress = 0;
  let closing = false;     // this attempt is over and the window is closing
  const loadedAt = Date.now();

  // Finish this attempt and call again from this same window/pane: end the call, then load a
  // fresh call screen for the same chat (the call address without the old call's
  // server_info_data), where Start call rings her again. If Instagram answers that with
  // "Ready to join?" instead, fall back to closing the window so the chat tab starts the call.
  const FRESH_KEY = "igLoopFresh";   // sessionStorage: "trying" | "failed"
  const freshUrl = () => {
    const u = new URL(location.href);
    u.searchParams.delete("server_info_data");
    return u.toString();
  };
  const freshState = () => { try { return sessionStorage.getItem(FRESH_KEY); } catch (_) { return null; } };
  const setFresh = (v) => { try { sessionStorage.setItem(FRESH_KEY, v); } catch (_) {} };

  const finish = async () => {
    closing = true;
    const end = endButton();
    // Unanswered attempt = one more step of backoff; an answered one starts over.
    const prev = await get();
    await patch({ fails: herLastSeen ? 0 : (prev.fails || 0) + 1 });
    if (end) press(end);
    const canReuse = freshState() !== "failed" && new URL(location.href).searchParams.has("ig_thread_id");
    if (canReuse) {
      // Stay "open" so the chat tab doesn't dial too while this pane loads the new call screen.
      await patch({ lastAlive: Date.now() });
      setFresh("trying");
      // Go straight away: after End call, Instagram may send this window to the chat.
      // The 5s pause before calling again happens on the new screen instead.
      setTimeout(() => location.replace(freshUrl()), end ? 400 : 0);
      return;
    }
    // Chat tab calls again ~5s from now, once this window has had time to close.
    await patch({ lastAlive: Date.now() - DEAD_AFTER_MS + 5000 });   // lastDial kept: the chat tab still honours the backoff
    setTimeout(() => {
      window.close();
      // If the browser won't close it, blank it instead. That still ends the call, and
      // Instagram's next call reuses this window.
      setTimeout(() => { location.href = "about:blank"; }, 1500);
    }, end ? 1500 : 0);
  };

  // In the call window, while Loop call is on: press "Start call"; if she doesn't pick up
  // (or the call drops), end the call and close the window.
  const checkCallWindow = async () => {
    if (!isCallWindow || closing || window.top !== window) return;
    const now = Date.now();
    const herNow = remoteLive();
    if (herNow) herLastSeen = now;
    const s = await get();
    const myCallUrl = freshUrl();
    if (new URL(myCallUrl).searchParams.has("ig_thread_id") && s.callUrl !== myCallUrl) await patch({ callUrl: myCallUrl });
    if (!s.on || herNow) return;            // off, or she's on the call: leave it alone
    if (now - lastPress < 3000) return;

    const REDIAL_PAUSE_MS = 5000;  // gap between one call ending and the next ringing
    const reused = freshState() === "trying" || freshState() === "works";
    if (!ringingSince && reused && now - loadedAt < REDIAL_PAUSE_MS) return;
    const start = !ringingSince && startButton();
    if (start) {                            // "Ready to call?"
      // Same limiter as the chat tab: wait out the gap since the last dial (this window stays
      // open meanwhile, so the chat tab doesn't dial either).
      if (now - (s.lastDial || 0) < gapFor(s)) return;
      press(start);
      if (freshState() === "trying") setFresh("works");
      lastPress = ringingSince = now;
      await patch({ attempts: (s.attempts || 0) + 1, lastDial: now });
      return;
    }

    // Instagram stopped ringing by itself: "No answer" / ended screen, or its call screen came back.
    const text = document.body?.innerText || "";
    const igGaveUp = ringingSince && !herLastSeen && now - ringingSince > 5000 &&
      (ENDED_TEXT.test(text) || /ready to (call|join)/i.test(text) || !!startButton());
    const noAnswer = igGaveUp ||
      (ringingSince && !herLastSeen && now - ringingSince > RING_TIMEOUT_MS);
    const dropped = herLastSeen && now - herLastSeen > DROP_TIMEOUT_MS;
    // A "Ready to join?" screen, or an ended screen, can't ring her again: close it.
    const deadScreen = !ringingSince && now - loadedAt > 4000 && !startButton() &&
      (/ready to join|join call/i.test(text) || ENDED_TEXT.test(text));
    // A fresh call screen we loaded came up as "Ready to join?": reusing this window doesn't
    // work here, so from now on close it and let the chat tab call.
    const freshStuck = !ringingSince && freshState() === "trying" && now - loadedAt > 15000 && !startButton();
    if ((deadScreen || freshStuck) && freshState() === "trying") setFresh("failed");
    if (freshStuck) return finish();
    if (noAnswer || dropped || deadScreen) await finish();
  };

  // While a call window is open, it counts as the call, so the chat tab never opens a second one.
  every(HEARTBEAT_MS, async () => {
    await checkCallWindow();
    if (closing) return;
    if ((isCallWindow && window.top === window) || inCall()) return patch({ lastAlive: Date.now() });
  });

  // ---------- DM tab only: toggle + redial ----------
  if (window.top !== window) return;

  const threadPath = () => (location.pathname.match(/^\/direct\/t\/[^/]+/) || [null])[0];
  document.getElementById("igloop-pill")?.remove();  // pill left behind by an older copy
  let state = {};
  let pill = null;
  let status = "";   // why it isn't dialing right now, shown on the pill

  const callButton = () => {
    const re = CALL_TYPE === "video" ? /video call|video chat/i : /audio call|voice call|audio chat/i;
    const label = (n) => n.getAttribute("aria-label") || n.getAttribute("title") ||
      n.querySelector("title")?.textContent || "";
    const el = [...document.querySelectorAll("[aria-label], [title], svg")]
      .find((n) => !n.closest("#igloop-pill") && re.test(label(n)));
    return el ? el.closest('[role="button"], button, a') || el : null;
  };

  // The pill can be dragged anywhere; where you leave it is remembered.
  const POS_KEY = "igLoopPos";
  const loadPos = () => { try { return JSON.parse(localStorage.getItem(POS_KEY)); } catch (_) { return null; } };
  const savePos = (x, y) => { try { localStorage.setItem(POS_KEY, JSON.stringify({ x, y })); } catch (_) {} };
  const placePill = (x, y) => {   // keep it fully on screen
    const r = pill.getBoundingClientRect();
    x = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - r.width));
    y = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - r.height));
    pill.style.left = x + "px"; pill.style.top = y + "px";
    pill.style.right = "auto"; pill.style.bottom = "auto";
    return [x, y];
  };
  let dragged = false;
  const makeDraggable = () => {
    pill.style.touchAction = "none";
    pill.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const r = pill.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const sx = e.clientX, sy = e.clientY;
      dragged = false;
      pill.setPointerCapture(e.pointerId);
      const move = (m) => {
        if (!dragged && Math.hypot(m.clientX - sx, m.clientY - sy) < 5) return;   // a click, not a drag
        dragged = true;
        placePill(m.clientX - dx, m.clientY - dy);
      };
      const up = () => {
        pill.removeEventListener("pointermove", move);
        pill.removeEventListener("pointerup", up);
        pill.removeEventListener("pointercancel", up);
        if (dragged) { const b = pill.getBoundingClientRect(); savePos(b.left, b.top); }
      };
      pill.addEventListener("pointermove", move);
      pill.addEventListener("pointerup", up);
      pill.addEventListener("pointercancel", up);
    });
    window.addEventListener("resize", () => {
      if (!pill || !pill.style.left) return;
      const b = pill.getBoundingClientRect(); placePill(b.left, b.top);
    });
  };

  const render = () => {
    const thread = threadPath();
    const show = thread && (!state.on || state.thread === thread);
    if (!show) { pill?.remove(); pill = null; return; }
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "igloop-pill";
      pill.setAttribute("role", "button");
      pill.setAttribute("tabindex", "0");
      pill.style.cssText =
        "position:fixed;bottom:16px;right:16px;z-index:2147483647;height:36px;padding:0 14px 0 5px;border-radius:18px;" +
        "background:rgba(28,28,30,.6);backdrop-filter:saturate(180%) blur(24px);-webkit-backdrop-filter:saturate(180%) blur(24px);" +
        "box-shadow:inset 0 0 0 .5px rgba(255,255,255,.18),0 6px 20px rgba(0,0,0,.35);color:#fff;" +
        "font:500 13px -apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;letter-spacing:-.01em;" +
        "cursor:grab;user-select:none;display:flex;gap:8px;align-items:center";
      pill.addEventListener("click", async () => {
        if (dragged) { dragged = false; return; }   // the end of a drag isn't a toggle
        state = state.on ? await patch({ on: false })
                         : await patch({ on: true, thread: threadPath(), attempts: 0, lastDial: 0, fails: 0 });
        render();
      });
      pill.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pill.click(); }
      });
      document.body.appendChild(pill);
      makeDraggable();
      const saved = loadPos();
      if (saved) placePill(saved.x, saved.y);
    }
    const dot = `<span style="width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;` +
      `background:${state.on ? "linear-gradient(45deg,#FEDA75,#FA7E1E,#D62976,#962FBF,#4F5BD5)" : "#3A3A3C"}">` +
      `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg></span>`;
    pill.title = "Drag to move";
    pill.innerHTML = state.on
      ? `${dot}<span>Loop call on</span><span style="opacity:.55">·</span><span style="opacity:.7">${state.attempts || 0} dialed</span>` +
        (status ? `<span style="opacity:.55">·</span><span style="color:#FFD60A">${status}</span>` : "")
      : `${dot}<span>Loop call</span><span style="opacity:.45;font-weight:400">off</span>`;
    if (pill.style.left) { const b = pill.getBoundingClientRect(); placePill(b.left, b.top); }  // text width changed
  };

  store.onChanged.addListener((changes) => {
    if (changes[KEY]) { state = changes[KEY].newValue || {}; render(); }
  });

  const tick = async () => {
    state = await get();
    render();
    if (!state.on || threadPath() !== state.thread) return;
    const now = Date.now();
    const say = (s) => { if (s !== status) { status = s; render(); } };
    if (now - (state.lastAlive || 0) < DEAD_AFTER_MS) return say("call open");
    const wait = gapFor(state) - (now - (state.lastDial || 0));
    if (wait > 0) return say(`next try in ${wait > 90000 ? Math.ceil(wait / 60000) + "m" : Math.ceil(wait / 1000) + "s"}`);
    const btn = callButton();
    if (!btn) return say("can't find call button");
    say("");
    // Claim this attempt first so a second tab on the same thread doesn't dial too.
    state = await patch({ lastDial: now });
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    render();
  };

  every(1000, tick);
  tick().catch(() => {});
})();
