// Runs in the page's own JS world before Instagram loads.
// Captures the local camera/mic streams so content.js can mute them directly
// when Instagram's own buttons can't be found.
(() => {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia || md.__igpipHooked) return;
  md.__igpipHooked = true;

  const streams = [];
  const root = document.documentElement;

  const liveTracks = (kind) =>
    streams.flatMap((s) => s.getTracks()).filter((t) => t.kind === kind && t.readyState === "live");

  // Publish state as data attributes: strings cross the isolated-world boundary, JS objects don't.
  const publish = () => {
    const ids = streams.flatMap((s) => s.getTracks()).map((t) => t.id);
    root.dataset.igpipLocal = ids.join(",");
    const audio = liveTracks("audio");
    const video = liveTracks("video");
    root.dataset.igpipMic = audio.length ? (audio.some((t) => t.enabled) ? "on" : "off") : "none";
    root.dataset.igpipCam = video.length ? (video.some((t) => t.enabled) ? "on" : "off") : "none";
  };

  const original = md.getUserMedia.bind(md);
  md.getUserMedia = async (constraints) => {
    const stream = await original(constraints);
    streams.push(stream);
    stream.getTracks().forEach((t) => t.addEventListener("ended", publish));
    publish();
    return stream;
  };

  window.addEventListener("igpip:toggle", (e) => {
    const kind = e.detail === "mic" ? "audio" : "video";
    const tracks = liveTracks(kind);
    if (!tracks.length) return;
    const enable = !tracks.some((t) => t.enabled);
    tracks.forEach((t) => (t.enabled = enable));
    publish();
  });
})();
