// Instagram Call PiP: floats the call into an always-on-top window with mic/camera/hang-up controls.
(() => {
  if (window.__igpipLoaded) return;
  window.__igpipLoaded = true;

  const root = document.documentElement;

  // ---------- Instagram's own call buttons ----------
  // Matched by aria-label / title / text. If Instagram renames them, adjust these patterns.
  const PATTERNS = {
    mic: /\b(un)?mute\b|microphone|\bmic\b|audio/i,
    cam: /camera|\bvideo\b/i,
    hangup: /end call|leave call|hang ?up|\bend\b|\bleave\b/i,
  };

  const labelOf = (el) =>
    (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();

  const findButton = (kind) => {
    const els = document.querySelectorAll('button, [role="button"]');
    for (const el of els) {
      if (el.closest("#igpip-pill")) continue;
      const label = labelOf(el);
      if (!label || label.length > 40) continue;
      if (kind === "mic" && PATTERNS.mic.test(label) && !PATTERNS.cam.test(label)) return el;
      if (kind === "cam" && PATTERNS.cam.test(label) && !/call/i.test(label)) return el;
      if (kind === "hangup" && PATTERNS.hangup.test(label)) return el;
    }
    return null;
  };

  // "on" | "off" | null, read from Instagram's button label, or from the captured local tracks.
  const readState = (kind) => {
    const btn = findButton(kind);
    if (btn) {
      const pressed = btn.getAttribute("aria-pressed");
      const label = labelOf(btn).toLowerCase();
      if (kind === "mic") {
        if (/unmute/.test(label)) return "off";
        if (/mute/.test(label)) return "on";
      } else {
        if (/turn on|start|enable|camera off|video off/.test(label)) return "off";
        if (/turn off|stop|disable/.test(label)) return "on";
      }
      if (pressed === "true") return "off";
      if (pressed === "false") return "on";
    }
    const hooked = root.dataset[kind === "mic" ? "igpipMic" : "igpipCam"];
    return hooked === "on" || hooked === "off" ? hooked : null;
  };

  const toggle = (kind) => {
    const btn = findButton(kind);
    if (btn) btn.click();
    else window.dispatchEvent(new CustomEvent("igpip:toggle", { detail: kind }));
    setTimeout(refreshControls, 150);
  };

  const hangUp = () => {
    const btn = findButton("hangup");
    if (btn) btn.click();
    closePip();
  };

  // ---------- Call detection ----------
  const callVideos = () =>
    [...document.querySelectorAll("video")].filter((v) => {
      const s = v.srcObject;
      return s instanceof MediaStream && s.getTracks().some((t) => t.readyState === "live");
    });

  const localIds = () => new Set((root.dataset.igpipLocal || "").split(",").filter(Boolean));

  const isLocal = (video, ids) => {
    const tracks = video.srcObject?.getTracks() || [];
    if (tracks.some((t) => ids.has(t.id))) return true;
    return false;
  };

  // True when the video is actually receiving frames (not ended, not paused by the network).
  const hasFrames = (video) => {
    const t = video?.srcObject?.getVideoTracks?.()[0];
    return !!t && t.readyState === "live" && !t.muted && video.videoWidth > 0;
  };

  // When each video element first appeared, so the newest one wins ties (e.g. after she switches devices).
  const firstSeen = new WeakMap();
  const seenAt = (v) => {
    if (!firstSeen.has(v)) firstSeen.set(v, Date.now());
    return firstSeen.get(v);
  };

  // Time of the last moment a call video was on the page; a device switch leaves a short gap.
  let lastCallSeen = 0;
  const CALL_GAP_MS = 10000;

  // ---------- Her mic: muted / speaking ----------
  // Her audio track is any live incoming audio track that isn't one of yours.
  // It may sit on her <video> or on a separate <audio>.
  const remoteAudioTrack = () => {
    const ids = localIds();
    for (const el of document.querySelectorAll("video, audio")) {
      const s = el.srcObject;
      if (!(s instanceof MediaStream)) continue;
      const t = s.getAudioTracks().find((a) => a.readyState === "live" && !ids.has(a.id));
      if (t) return t;
    }
    return null;
  };

  // Instagram may label her muted state on screen, e.g. "Microphone muted" or "<name> is muted".
  // Our own buttons say "Mute"/"Unmute", which this deliberately doesn't match.
  const remoteMutedLabel = () => {
    for (const el of document.querySelectorAll("[aria-label], [title]")) {
      if (el.closest('button, [role="button"], #igpip-pill')) continue;
      if (/\bmuted\b|mic(rophone)? (is )?off/i.test(el.getAttribute("aria-label") || el.getAttribute("title") || "")) return true;
    }
    return false;
  };

  // Measures her audio level without affecting playback; "speaking" = recent sound above a threshold.
  const voice = {
    ctx: null, analyser: null, source: null, trackId: null, data: null, lastLoud: 0,
    attach(track) {
      if (!track || track.id === this.trackId) return;
      try {
        this.ctx ||= new AudioContext();
        this.ctx.resume().catch(() => {});
        // Her track changes when she switches devices; drop the old one before measuring the new one.
        this.source?.disconnect();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 512;
        this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
        this.source.connect(this.analyser);
        this.data = new Uint8Array(this.analyser.fftSize);
        this.trackId = track.id;
      } catch (err) {
        console.warn("[igpip] can't measure her audio level", err);
      }
    },
    level() {
      if (!this.analyser) return 0;
      this.analyser.getByteTimeDomainData(this.data);
      let sum = 0;
      for (const v of this.data) sum += ((v - 128) / 128) ** 2;
      return Math.sqrt(sum / this.data.length);
    },
    speaking() {
      if (this.level() > 0.02) this.lastLoud = Date.now();
      return Date.now() - this.lastLoud < 400;
    },
    stop() {
      this.ctx?.close().catch(() => {});
      this.ctx = this.analyser = this.source = this.trackId = null;
    },
  };

  // "muted" | "speaking" | "quiet" | null (no audio track found)
  const remoteMicState = () => {
    const track = remoteAudioTrack();
    if (!track) return remoteMutedLabel() ? "muted" : null;
    if (track.muted || remoteMutedLabel()) return "muted";
    voice.attach(track);
    return voice.speaking() ? "speaking" : "quiet";
  };

  // Splits call videos into her video (remote) and your self-view (local).
  // Prefers videos that are receiving frames, then the biggest, then the newest.
  // After a device switch Instagram may leave the old, frozen video on the page next to the new one.
  const pickVideos = () => {
    const vids = callVideos();
    if (!vids.length) return { remote: null, self: null };
    const ids = localIds();
    let self = vids.find((v) => isLocal(v, ids)) || null;
    const others = vids.filter((v) => v !== self);
    const area = (v) => v.getBoundingClientRect().width * v.getBoundingClientRect().height;
    others.sort((a, b) => hasFrames(b) - hasFrames(a) || area(b) - area(a) || seenAt(b) - seenAt(a));
    let remote = others[0] || null;
    // When we know which video is yours, never show it as hers: while she switches devices
    // there's briefly no video of hers at all.
    if (self) return { remote, self };
    // Without the camera hook we can only guess: the smaller video is probably your self-view.
    if (others.length > 1) self = others[others.length - 1];
    return { remote, self };
  };

  // ---------- Pop-out pill on the Instagram page ----------
  let pill = null;
  let callStart = null;

  const ensurePill = () => {
    if (pill) return;
    pill = document.createElement("div");
    pill.id = "igpip-pill";
    pill.setAttribute("role", "button");
    pill.setAttribute("tabindex", "0");
    pill.style.cssText =
      "position:fixed;top:14px;right:14px;z-index:2147483647;height:36px;padding:0 14px 0 5px;border-radius:18px;" +
      "background:rgba(28,28,30,.6);backdrop-filter:saturate(180%) blur(24px);-webkit-backdrop-filter:saturate(180%) blur(24px);" +
      "box-shadow:inset 0 0 0 .5px rgba(255,255,255,.18),0 6px 20px rgba(0,0,0,.35);color:#fff;" +
      "font:500 13px -apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;letter-spacing:-.01em;" +
      "cursor:pointer;user-select:none;display:flex;gap:8px;align-items:center;transition:transform .2s cubic-bezier(.2,.9,.25,1.15)";
    pill.addEventListener("click", () => (pipWin ? closePip() : openPip()));
    pill.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pill.click(); }
    });
    pill.addEventListener("pointerdown", () => (pill.style.transform = "scale(.95)"));
    pill.addEventListener("pointerup", () => (pill.style.transform = ""));
    pill.addEventListener("pointerleave", () => (pill.style.transform = ""));
    document.body.appendChild(pill);
    updatePill();
  };

  const updatePill = () => {
    if (!pill) return;
    pill.innerHTML = pipWin
      ? `${pillIcon()}<span>In floating window</span><span style="opacity:.55">·</span><span style="color:#7CB8FF">Bring back</span>`
      : `${pillIcon()}<span>${pillLabel}</span><span style="opacity:.45;font-weight:400">⌥P</span>`;
  };

  let pillLabel = "Pop out";

  // Instagram-gradient circle with a picture-in-picture glyph.
  const pillIcon = () =>
    `<span style="width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;` +
    `background:linear-gradient(45deg,#FEDA75,#FA7E1E,#D62976,#962FBF,#4F5BD5)">` +
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<rect x="2" y="4" width="20" height="16" rx="3"/><rect x="12" y="11" width="7" height="6" rx="1.5" fill="#fff"/></svg></span>`;

  const removePill = () => {
    pill?.remove();
    pill = null;
  };

  // ---------- Floating window ----------
  let pipWin = null;        // Document PiP window
  let videoPip = false;     // fallback: native video PiP
  let docPipBroken = false; // Document PiP failed once; use video PiP from now on
  let mirrors = null;       // { remote, self }: our own <video>s in the floating window
  let syncTimer = null;     // keeps the mirrors on Instagram's current streams
  let controls = null;      // { mic, cam, self, timer, muteBadge }
  let lastState = "";       // avoids re-rendering buttons when nothing changed

  // Window size presets (width x height). Double-click the corner grip or use the size button to cycle.
  const SIZES = [
    { name: "XS", w: 150, h: 200 },
    { name: "S", w: 220, h: 300 },
    { name: "M", w: 300, h: 410 },
    { name: "L", w: 380, h: 520 },
  ];
  // Our own floor; the browser may enforce a larger minimum of its own.
  const MIN_W = 120, MIN_H = 150;

  // Remembered between calls. Instagram's localStorage, with our own key prefix.
  const prefs = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem("igpip-" + key)) ?? fallback; } catch (_) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("igpip-" + key, JSON.stringify(value)); } catch (_) {}
    },
  };

  // Lucide icons (ISC licence), drawn in the style of SF Symbols.
  const ICONS = {
    mic: '<svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>',
    micOff: '<svg viewBox="0 0 24 24"><path d="m2 2 20 20"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><path d="M12 19v3"/></svg>',
    cam: '<svg viewBox="0 0 24 24"><path d="m16 13 5.22 3.48a.5.5 0 0 0 .78-.42V7.87a.5.5 0 0 0-.75-.43L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>',
    camOff: '<svg viewBox="0 0 24 24"><path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.25-3.06a.5.5 0 0 1 .75.43v8.2"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/><path d="m2 2 20 20"/></svg>',
    hangup: '<svg viewBox="0 0 24 24" class="solid"><path transform="rotate(135 12 12)" d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z"/></svg>',
    size: '<svg viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>',
    grip: '<svg viewBox="0 0 24 24"><path d="M21 11 11 21"/><path d="m21 17-4 4"/></svg>',
  };

  // FaceTime-style glass controls with an Instagram-gradient ring when she's speaking.
  const CSS = `
    :root{
      --glass:rgba(28,28,30,.52);--glass-strong:rgba(44,44,46,.72);--hairline:rgba(255,255,255,.14);
      --red:#FF3B30;--green:#34C759;
      --ig:linear-gradient(45deg,#FEDA75,#FA7E1E,#D62976,#962FBF,#4F5BD5);
      --spring:cubic-bezier(.2,.9,.25,1.15);--ease:cubic-bezier(.25,.1,.25,1);
      --blur:saturate(180%) blur(24px);
    }
    *{box-sizing:border-box}
    html,body{margin:0;height:100%;background:#000;color:#fff;overflow:hidden;user-select:none;-webkit-font-smoothing:antialiased;
      font:500 12px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;letter-spacing:-.01em}
    #win{position:absolute;inset:0;container:win/size}
    #stage{position:absolute;inset:0;background:#1C1C1E}
    #stage video.remote{width:100%;height:100%;object-fit:cover;display:block}
    #ring{position:absolute;inset:0;border:3px solid transparent;border-image:var(--ig) 1;opacity:0;transition:opacity .3s var(--ease);pointer-events:none}
    #ring.on{opacity:1}
    .fade{transition:opacity .3s var(--ease),transform .35s var(--spring)}
    body.idle .fade{opacity:0;pointer-events:none}
    body.idle #bar{transform:translate(-50%,10px) scale(.97)}
    #shade{position:absolute;inset:auto 0 0 0;height:45%;background:linear-gradient(to top,rgba(0,0,0,.5),transparent);pointer-events:none}
    #topShade{position:absolute;inset:0 0 auto 0;height:70px;background:linear-gradient(to bottom,rgba(0,0,0,.35),transparent);pointer-events:none}
    .glass{background:var(--glass);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);box-shadow:inset 0 0 0 .5px var(--hairline)}
    #timer{position:absolute;left:10px;top:10px;height:24px;padding:0 10px 0 8px;border-radius:12px;display:flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums;font-size:12px}
    #timer i{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 0 2px rgba(52,199,89,.25)}
    #herMic{position:absolute;right:10px;top:10px;height:24px;padding:0 10px 0 7px;border-radius:12px;display:none;align-items:center;gap:5px;font-size:12px}
    #herMic.muted{display:flex}
    #herMic svg{width:14px;height:14px;color:var(--red)}
    #igpip-self{position:absolute;width:27%;max-width:112px;min-width:52px;aspect-ratio:3/4;border-radius:14px;overflow:hidden;background:#2C2C2E;
      display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none;
      box-shadow:0 8px 24px rgba(0,0,0,.45),inset 0 0 0 .5px var(--hairline);
      transition:left .35s var(--spring),top .35s var(--spring),right .35s var(--spring),bottom .35s var(--spring),transform .2s var(--ease)}
    #igpip-self:hover{transform:scale(1.03)}
    #igpip-self.dragging{transition:none;cursor:grabbing;transform:scale(1.06)}
    #igpip-self.tl{left:10px;top:44px}#igpip-self.tr{right:10px;top:44px}
    #igpip-self.bl{left:10px;bottom:84px}#igpip-self.br{right:10px;bottom:84px}
    #igpip-self video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1);pointer-events:none}
    #igpip-self .officon svg{width:22px;height:22px;color:rgba(255,255,255,.55)}
    #igpip-self.off video,#igpip-self.nostream video{display:none}
    #igpip-self:not(.off):not(.nostream) .officon{display:none}
    #reconnecting{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);height:30px;padding:0 14px 0 10px;border-radius:15px;
      display:flex;align-items:center;gap:8px;font-size:13px;white-space:nowrap;opacity:0;transition:opacity .3s var(--ease);pointer-events:none}
    #reconnecting.show{opacity:1}
    #reconnecting i{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;animation:spin .9s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    @container win (max-width:200px){#reconnecting span{display:none}#reconnecting{padding:0 8px}}
    #muteBadge{position:absolute;left:5px;top:5px;width:22px;height:22px;border-radius:50%;display:none;align-items:center;justify-content:center;z-index:1}
    #muteBadge.show{display:flex}
    #muteBadge svg{width:12px;height:12px;color:var(--red)}
    #bar{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);display:flex;gap:10px;padding:8px;border-radius:32px}
    button{width:44px;height:44px;border-radius:50%;border:0;padding:0;cursor:pointer;color:#fff;background:rgba(255,255,255,.16);
      display:flex;align-items:center;justify-content:center;transition:background .2s var(--ease),transform .25s var(--spring),color .2s var(--ease)}
    button:hover{background:rgba(255,255,255,.26)}
    button:active{transform:scale(.9)}
    button:focus-visible,#igpip-self:focus-visible{outline:2px solid #fff;outline-offset:2px}
    button.off{background:#fff;color:#000}
    button.off:hover{background:rgba(255,255,255,.88)}
    button.end{background:var(--red)}
    button.end:hover{background:#FF5147}
    svg{fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
    svg.solid{fill:currentColor;stroke:none}
    button svg{width:20px;height:20px}
    #grip{position:absolute;right:2px;bottom:2px;width:22px;height:22px;cursor:nwse-resize;display:flex;align-items:flex-end;justify-content:flex-end;padding:3px;color:rgba(255,255,255,.5);touch-action:none}
    #grip svg{width:13px;height:13px;stroke-width:2.2}
    #sizeTip{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);height:28px;padding:0 14px;border-radius:14px;display:flex;align-items:center;font-variant-numeric:tabular-nums;font-size:13px;opacity:0;transition:opacity .2s var(--ease);pointer-events:none}
    #sizeTip.show{opacity:1}
    @container win (max-width:260px){
      button{width:36px;height:36px}button svg{width:17px;height:17px}
      #bar{gap:7px;padding:6px;bottom:10px;border-radius:26px}#size{display:none}
      #igpip-self.bl,#igpip-self.br{bottom:66px}
      #herMic .txt{display:none}#herMic{padding:0;width:24px;justify-content:center}
    }
    @container win (max-width:200px){
      #timer,#topShade{display:none}
      #igpip-self.tl,#igpip-self.tr{top:10px}#herMic{right:8px;top:8px}
    }
    @container win (max-width:170px){
      #igpip-self{min-width:40px;width:34%;border-radius:10px}
      #igpip-self.tl{top:6px}#igpip-self.tr{top:36px}
      #igpip-self.tl,#igpip-self.bl{left:6px}#igpip-self.tr,#igpip-self.br{right:6px}
      #igpip-self.bl,#igpip-self.br{bottom:46px}
      #muteBadge{width:16px;height:16px;left:3px;top:3px}#muteBadge svg{width:10px;height:10px}
      button{width:30px;height:30px}button svg{width:14px;height:14px}
      #bar{gap:5px;padding:4px;bottom:7px}
      #ring{border-width:2px}
    }
    /* Short, wide windows (the "strip" sizes): self-view sits in a top corner, sized by height. */
    @container win (max-height:240px){
      #timer,#topShade{display:none}
      #herMic{left:8px;right:auto;top:8px}
      #igpip-self,#igpip-self.tl,#igpip-self.tr,#igpip-self.bl,#igpip-self.br{
        top:8px;bottom:auto;height:calc(100% - 64px);width:auto;min-width:0;max-width:none;border-radius:10px}
      #igpip-self.tl,#igpip-self.bl{left:8px;right:auto}#igpip-self.tr,#igpip-self.br{right:8px;left:auto}
      #win:has(#igpip-self.tl,#igpip-self.bl) #herMic{left:auto;right:8px}
      button{width:34px;height:34px}button svg{width:16px;height:16px}
      #bar{gap:6px;padding:5px;bottom:8px;border-radius:24px}#size{display:none}
    }
    @container win (max-height:150px){
      #igpip-self,#igpip-self.tl,#igpip-self.tr,#igpip-self.bl,#igpip-self.br{height:calc(100% - 52px)}
      button{width:28px;height:28px}button svg{width:14px;height:14px}
      #bar{gap:4px;padding:4px;bottom:6px}
      #muteBadge{width:16px;height:16px;left:3px;top:3px}#muteBadge svg{width:10px;height:10px}
    }
    @media (prefers-reduced-motion:reduce){*{transition:none !important;animation:none !important}}
  `;

  // ---------- Mirroring Instagram's videos ----------
  // Instagram's own <video> elements stay on the page; the floating window shows the same streams
  // in its own muted <video>s (Instagram's element keeps playing the sound). When she switches
  // devices Instagram creates a new stream, often on a new element, and we follow it.
  const makeMirror = (doc, cls) => {
    const v = doc.createElement("video");
    v.className = cls;
    v.autoplay = v.playsInline = v.muted = true;
    return v;
  };

  const showStream = (mirror, source) => {
    const stream = source?.srcObject || null;
    if (!stream || mirror.srcObject === stream) return;
    mirror.srcObject = stream;
    mirror.play().catch(() => {});
  };

  // Runs twice a second while the window is open.
  const syncVideos = () => {
    if (!mirrors) return;
    const { remote, self } = pickVideos();
    showStream(mirrors.remote, remote);
    showStream(mirrors.self, self);
    if (controls) {
      controls.self.classList.toggle("nostream", !mirrors.self.srcObject);
      // No frames from her (switching devices, bad network): say so instead of showing black.
      controls.reconnecting.classList.toggle("show", !hasFrames(mirrors.remote));
    }
  };

  const openPip = async () => {
    if (pipWin || videoPip) return;
    const { remote, self } = pickVideos();
    if (!remote) return;

    if (!("documentPictureInPicture" in window) || docPipBroken) return openVideoPip(remote);

    const saved = prefs.get("size", { w: SIZES[1].w, h: SIZES[1].h });
    try {
      // disallowReturnToOpener hides the browser's "back to tab" arrow; the rest of the title bar can't be changed.
      pipWin = await window.documentPictureInPicture.requestWindow({
        width: saved.w,
        height: saved.h,
        disallowReturnToOpener: true,
      });
    } catch (err) {
      // The click's user gesture is spent by now, so video PiP must wait for the next click.
      console.warn("[igpip] Document PiP failed; next click uses video PiP", err);
      docPipBroken = true;
      pillLabel = "Click again to pop out";
      updatePill();
      return;
    }

    const doc = pipWin.document;
    doc.title = "Instagram call";
    const style = doc.createElement("style");
    style.textContent = CSS;
    doc.head.appendChild(style);
    doc.body.innerHTML = `
      <div id="win">
        <div id="stage"></div>
        <div id="reconnecting" class="glass" role="status"><i></i><span>Reconnecting…</span></div>
        <div id="ring" title="She's speaking"></div>
        <div id="topShade" class="fade"></div>
        <div id="shade" class="fade"></div>
        <div id="timer" class="glass fade"><i></i><span>00:00:00</span></div>
        <div id="herMic" class="glass" role="status" title="Her mic is muted">
          <span class="ico">${ICONS.micOff}</span><span class="txt">Muted</span>
        </div>
        <div id="igpip-self" title="Drag to move" tabindex="0">
          <div id="muteBadge" class="glass" role="status" title="Your mic is muted">${ICONS.micOff}</div>
          <span class="officon">${ICONS.camOff}</span>
        </div>
        <div id="bar" class="glass fade">
          <button id="mic" aria-label="Mute mic" title="Mute mic (M)"></button>
          <button id="cam" aria-label="Turn camera off" title="Turn camera off (V)"></button>
          <button id="size" aria-label="Change size" title="Change size (S)">${ICONS.size}</button>
          <button id="end" class="end" aria-label="Hang up" title="Hang up">${ICONS.hangup}</button>
        </div>
        <div id="grip" class="fade" title="Drag to resize · double-click to change size">${ICONS.grip}</div>
        <div id="sizeTip" class="glass"></div>
      </div>`;

    const $ = (id) => doc.getElementById(id);
    const selfBox = $("igpip-self");
    mirrors = { remote: makeMirror(doc, "remote"), self: makeMirror(doc, "self") };
    $("stage").appendChild(mirrors.remote);
    selfBox.appendChild(mirrors.self);
    showStream(mirrors.remote, remote);
    showStream(mirrors.self, self);
    selfBox.classList.add(prefs.get("corner", "br"));

    controls = {
      mic: $("mic"),
      cam: $("cam"),
      self: selfBox,
      timer: $("timer").querySelector("span"),
      muteBadge: $("muteBadge"),
      herMic: $("herMic"),
      ring: $("ring"),
      reconnecting: $("reconnecting"),
    };
    lastState = "";
    controls.mic.onclick = () => toggle("mic");
    controls.cam.onclick = () => toggle("cam");
    $("end").onclick = hangUp;
    $("size").onclick = () => cycleSize();
    doc.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      if (k === "m") toggle("mic");
      if (k === "v") toggle("cam");
      if (k === "s") cycleSize();
    });

    setupAutoHide(doc);
    setupResize(doc, $("grip"), $("sizeTip"));
    setupSelfDrag(doc, selfBox);

    pipWin.addEventListener("resize", () => {
      prefs.set("size", { w: pipWin.innerWidth, h: pipWin.innerHeight });
    });
    // Her mic status updates 5x a second so the speaking bars follow her voice.
    const herMicTimer = setInterval(() => {
      if (!controls) return;
      const state = remoteMicState();
      controls.herMic.classList.toggle("muted", state === "muted");
      controls.ring.classList.toggle("on", state === "speaking");
    }, 200);

    syncTimer = setInterval(syncVideos, 500);
    syncVideos();

    pipWin.addEventListener("pagehide", () => {
      clearInterval(herMicTimer);
      clearInterval(syncTimer);
      voice.stop();
      mirrors = null;
      pipWin = null;
      controls = null;
      updatePill();
    });

    refreshControls();
    updatePill();
  };

  // Controls fade out after 2.5 s without mouse movement, and come back on hover.
  const setupAutoHide = (doc) => {
    let timer;
    const wake = () => {
      doc.body.classList.remove("idle");
      clearTimeout(timer);
      timer = setTimeout(() => doc.body.classList.add("idle"), 2500);
    };
    doc.addEventListener("pointermove", wake);
    doc.addEventListener("pointerdown", wake);
    doc.addEventListener("keydown", wake);
    doc.documentElement.addEventListener("mouseleave", () => {
      clearTimeout(timer);
      doc.body.classList.add("idle");
    });
    wake();
  };

  // The browser has its own minimum window size (Arc's title bar needs room for its buttons).
  // We learn it the first time a resize gets clamped, and show it so the limit isn't a mystery.
  let browserMin = prefs.get("browserMin", null);

  const resizeWin = (w, h, { report = false } = {}) => {
    if (!pipWin) return false;
    w = Math.max(MIN_W, Math.round(w));
    h = Math.max(MIN_H, Math.round(h));
    try {
      pipWin.resizeTo(w, h);
    } catch (err) {
      // resizeTo needs a fresh click; the pointerup at the end of a drag provides one.
      return false;
    }
    if (report) setTimeout(() => checkClamped(w, h), 250);
    return true;
  };

  const checkClamped = (w, h) => {
    if (!pipWin) return;
    const aw = pipWin.outerWidth, ah = pipWin.outerHeight;
    const clampedW = aw > w + 4, clampedH = ah > h + 4;
    if (!clampedW && !clampedH) return;
    // Only a clamped side tells us its minimum; the other side keeps what we knew (or our own floor).
    browserMin = {
      w: clampedW ? aw : browserMin?.w ?? MIN_W,
      h: clampedH ? ah : browserMin?.h ?? MIN_H,
    };
    prefs.set("browserMin", browserMin);
    const tip = pipWin.document.getElementById("sizeTip");
    if (tip) showSizeTip(tip, `Smallest Arc allows: ${aw} × ${ah}`, 1800);
  };

  // Presets, with the smallest one adapted to the browser's minimum width:
  // if the window can't get narrower, the smallest size becomes a short strip instead.
  const sizes = () => {
    if (!browserMin || browserMin.w <= SIZES[0].w) return SIZES;
    const strip = { name: "XS", w: browserMin.w, h: Math.max(browserMin.h, MIN_H) };
    return [strip, ...SIZES.slice(1).filter((s) => s.w > browserMin.w + 10)];
  };

  const showSizeTip = (tip, text, ms = 900) => {
    tip.textContent = text;
    tip.classList.add("show");
    clearTimeout(tip._t);
    tip._t = setTimeout(() => tip.classList.remove("show"), ms);
  };

  // Steps small → large, then wraps to the smallest. Uses area so a short strip counts as smallest.
  const cycleSize = () => {
    if (!pipWin) return;
    const area = pipWin.outerWidth * pipWin.outerHeight;
    const list = sizes();
    const next = list.find((s) => s.w * s.h > area * 1.1) || list[0];
    resizeWin(next.w, next.h, { report: true });
    const tip = pipWin.document.getElementById("sizeTip");
    if (tip) showSizeTip(tip, `Size ${next.name}`);
  };

  // Drag the bottom-right grip to resize the window yourself.
  const setupResize = (doc, grip, tip) => {
    let start = null;
    let pending = null;
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      start = { x: e.screenX, y: e.screenY, w: pipWin.outerWidth, h: pipWin.outerHeight };
    });
    grip.addEventListener("pointermove", (e) => {
      if (!start) return;
      pending = { w: start.w + (e.screenX - start.x), h: start.h + (e.screenY - start.y) };
      resizeWin(pending.w, pending.h);
      // Show the size the window actually is, which stops at the browser's minimum.
      showSizeTip(tip, `${pipWin.outerWidth} × ${pipWin.outerHeight}`);
    });
    const end = () => {
      if (pending) resizeWin(pending.w, pending.h, { report: true });
      start = pending = null;
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    grip.addEventListener("dblclick", cycleSize);
  };

  // Drag your self-view; it snaps to the nearest corner.
  const setupSelfDrag = (doc, box) => {
    let drag = null;
    box.addEventListener("pointerdown", (e) => {
      const r = box.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      box.setPointerCapture(e.pointerId);
      box.classList.add("dragging");
    });
    box.addEventListener("pointermove", (e) => {
      if (!drag) return;
      box.classList.remove("tl", "tr", "bl", "br");
      box.style.left = e.clientX - drag.dx + "px";
      box.style.top = e.clientY - drag.dy + "px";
      box.style.right = box.style.bottom = "auto";
    });
    const drop = (e) => {
      if (!drag) return;
      drag = null;
      const r = box.getBoundingClientRect();
      const view = doc.documentElement;
      const corner =
        (r.top + r.height / 2 < view.clientHeight / 2 ? "t" : "b") +
        (r.left + r.width / 2 < view.clientWidth / 2 ? "l" : "r");
      box.style.left = box.style.top = box.style.right = box.style.bottom = "";
      box.classList.remove("dragging");
      box.classList.add(corner);
      prefs.set("corner", corner);
    };
    box.addEventListener("pointerup", drop);
    box.addEventListener("pointercancel", drop);
  };

  // A video leaving PiP only means the window closed if no other video took its place.
  const watchVideoPipLeave = (video) => {
    video.addEventListener("leavepictureinpicture", () => {
      setTimeout(() => { if (!document.pictureInPictureElement) videoPip = false; }, 100);
    }, { once: true });
  };

  // Fallback: Chromium's native video PiP, with mic/camera/hang-up buttons via Media Session.
  const openVideoPip = async (remote) => {
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler("togglemicrophone", () => toggle("mic"));
      ms.setActionHandler("togglecamera", () => toggle("cam"));
      ms.setActionHandler("hangup", hangUp);
    } catch (_) {}
    try {
      await remote.requestPictureInPicture();
      videoPip = true;
      watchVideoPipLeave(remote);
      refreshControls();
    } catch (err) {
      console.warn("[igpip] video PiP failed", err);
    }
  };

  // The fallback window shows one of Instagram's own elements. If she switches devices and a new
  // video takes over, move the window to it. That's allowed without a click while PiP is already open.
  const followVideoPip = () => {
    const current = document.pictureInPictureElement;
    const { remote } = pickVideos();
    if (!current || !remote || remote === current || hasFrames(current) || !hasFrames(remote)) return;
    remote.requestPictureInPicture().catch((err) => console.warn("[igpip] couldn't follow new video", err));
    watchVideoPipLeave(remote);
  };

  const closePip = () => {
    if (pipWin) pipWin.close();
    if (videoPip && document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  };

  const refreshControls = () => {
    const mic = readState("mic");
    const cam = readState("cam");

    if (videoPip) {
      const ms = navigator.mediaSession;
      try {
        if (mic) ms.setMicrophoneActive(mic === "on");
        if (cam) ms.setCameraActive(cam === "on");
      } catch (_) {}
    }
    if (!controls) return;

    const micOff = mic === "off";
    const camOff = cam === "off";
    const state = `${micOff}|${camOff}`;
    if (state !== lastState) {
      lastState = state;
      controls.mic.innerHTML = micOff ? ICONS.micOff : ICONS.mic;
      controls.mic.classList.toggle("off", micOff);
      controls.mic.title = micOff ? "Unmute mic (M)" : "Mute mic (M)";
      controls.mic.setAttribute("aria-label", micOff ? "Unmute mic" : "Mute mic");
      controls.cam.innerHTML = camOff ? ICONS.camOff : ICONS.cam;
      controls.cam.classList.toggle("off", camOff);
      controls.cam.title = camOff ? "Turn camera on (V)" : "Turn camera off (V)";
      controls.cam.setAttribute("aria-label", camOff ? "Turn camera on" : "Turn camera off");
      controls.self.classList.toggle("off", camOff);
      controls.muteBadge.classList.toggle("show", micOff);
    }

    if (callStart) {
      const s = Math.floor((Date.now() - callStart) / 1000);
      const two = (n) => String(n).padStart(2, "0");
      controls.timer.textContent = `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
    }
  };

  // ---------- Main loop ----------
  const tick = () => {
    if (callVideos().length) lastCallSeen = Date.now();
    // Switching devices briefly removes every video; only treat a longer gap as the call ending.
    const inCall = Date.now() - lastCallSeen < CALL_GAP_MS;
    if (inCall) {
      if (!callStart) callStart = Date.now();
      ensurePill();
    } else {
      callStart = null;
      removePill();
      closePip();
    }
    if (videoPip) followVideoPip();
    refreshControls();
  };

  setInterval(tick, 1000);
  new MutationObserver(() => {
    if (!pill && callVideos().length) tick();
  }).observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener("keydown", (e) => {
    if (e.altKey && (e.code === "KeyP")) {
      e.preventDefault();
      pipWin ? closePip() : openPip();
    }
  });
})();
