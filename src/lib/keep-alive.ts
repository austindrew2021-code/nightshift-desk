/** Picture-in-Picture + tiny audio so Chrome keeps ticking while YouTube is open. */

const KEY = "nightshift.keepalive";

let canvas: HTMLCanvasElement | null = null;
let audio: AudioContext | null = null;
let gain: GainNode | null = null;
let osc: OscillatorNode | null = null;
let timer = 0;
let videoEl: HTMLVideoElement | null = null;
let on = false;

export function keepAliveActive() {
  return on && Boolean(document.pictureInPictureElement);
}

function paint(note: string) {
  if (!canvas) return;
  const g = canvas.getContext("2d");
  if (!g) return;
  g.fillStyle = "#070B09";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#3DFF8A";
  g.font = "700 22px ui-monospace, monospace";
  g.fillText("NIGHTSHIFT", 16, 36);
  g.font = "12px ui-monospace, monospace";
  g.fillStyle = "#7A9A86";
  g.fillText("ICT live · leave this bubble on", 16, 58);
  g.fillStyle = "#3DFF8A";
  g.fillText(note, 16, 86);
  const t = new Date();
  g.fillText(t.toLocaleTimeString(), 16, 112);
}

export async function startKeepAlive(video: HTMLVideoElement): Promise<string> {
  videoEl = video;
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
  }
  paint("starting");
  const stream = canvas.captureStream(6);
  try {
    audio = audio ?? new AudioContext();
    if (audio.state === "suspended") await audio.resume();
    if (!osc) {
      gain = audio.createGain();
      gain.gain.value = 0.0004;
      osc = audio.createOscillator();
      osc.frequency.value = 48;
      osc.type = "sine";
      const dest = audio.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(dest);
      gain.connect(audio.destination);
      osc.start();
      const track = dest.stream.getAudioTracks()[0];
      if (track) stream.addTrack(track);
    }
  } catch {
    /* audio optional — PiP video is the keep-alive */
  }
  video.srcObject = stream;
  video.muted = false;
  video.volume = 0.05;
  video.playsInline = true;
  video.autoplay = true;
  await video.play();
  if (timer) window.clearInterval(timer);
  timer = window.setInterval(() => paint(on ? "scanning" : "idle"), 1000);
  if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
    if (document.pictureInPictureElement !== video) {
      await video.requestPictureInPicture();
    }
  } else {
    return "PiP not available on this Chrome — use split screen";
  }
  on = true;
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* ignore */
  }
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "NIGHTSHIFT ICT",
      artist: "leave the mini player on",
      album: "paper desk",
    });
    navigator.mediaSession.playbackState = "playing";
  } catch {
    /* ignore */
  }
  return "mini player on · YouTube in the other app is ok · don’t close the bubble";
}

export function stopKeepAlive() {
  on = false;
  if (timer) window.clearInterval(timer);
  timer = 0;
  if (document.pictureInPictureElement) {
    void document.exitPictureInPicture().catch(() => {});
  }
  if (videoEl) {
    videoEl.pause();
    videoEl.srcObject = null;
  }
  try {
    navigator.mediaSession.playbackState = "paused";
  } catch {
    /* ignore */
  }
}

export function wantsKeepAlive() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
