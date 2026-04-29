// Procedural audio. No external assets — generated with WebAudio so it deploys cleanly to GitHub Pages.

let ctx = null;
let masterGain = null;
let muted = false;

function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.45;
    masterGain.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
}

function tone({ freq = 440, dur = 0.15, type = "sine", gain = 0.2, slide = 0, when = 0 }) {
  if (muted) return;
  ensureCtx();
  const t0 = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function noise({ dur = 0.2, gain = 0.15, freq = 1500, q = 1, when = 0 }) {
  if (muted) return;
  ensureCtx();
  const t0 = ctx.currentTime + when;
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = "bandpass"; filt.frequency.value = freq; filt.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filt).connect(g).connect(masterGain);
  src.start(t0);
}

export const sfx = {
  resume() { ensureCtx(); },
  setMuted(v) { muted = v; if (masterGain) masterGain.gain.value = v ? 0 : 0.45; },
  jump()      { tone({ freq: 320, dur: 0.12, type: "square", gain: 0.12, slide: 200 }); },
  step()      { noise({ dur: 0.05, gain: 0.06, freq: 350, q: 2 }); },
  slash()     { noise({ dur: 0.18, gain: 0.18, freq: 2200, q: 1.5 }); tone({ freq: 540, dur: 0.08, type: "sawtooth", gain: 0.08, slide: -200 }); },
  plasma()    { tone({ freq: 880, dur: 0.18, type: "sawtooth", gain: 0.16, slide: -700 }); noise({ dur: 0.12, gain: 0.08, freq: 3500 }); },
  hit()       { tone({ freq: 200, dur: 0.1, type: "square", gain: 0.18, slide: -100 }); noise({ dur: 0.08, gain: 0.12, freq: 1200 }); },
  enemyHit()  { noise({ dur: 0.12, gain: 0.18, freq: 700, q: 0.7 }); tone({ freq: 140, dur: 0.12, type: "sawtooth", gain: 0.1, slide: -60 }); },
  enemyDie()  { tone({ freq: 600, dur: 0.4, type: "sawtooth", gain: 0.2, slide: -550 }); noise({ dur: 0.3, gain: 0.1, freq: 800 }); },
  pickup()    { tone({ freq: 880, dur: 0.08, type: "sine", gain: 0.18 }); tone({ freq: 1320, dur: 0.12, type: "sine", gain: 0.18, when: 0.08 }); },
  schmeckle() { tone({ freq: 1200, dur: 0.06, type: "triangle", gain: 0.18 }); tone({ freq: 1800, dur: 0.08, type: "triangle", gain: 0.16, when: 0.06 }); },
  questDone() { [880, 1100, 1320, 1760].forEach((f, i) => tone({ freq: f, dur: 0.18, type: "triangle", gain: 0.18, when: i * 0.1 })); },
  shout1()    { tone({ freq: 220, dur: 0.5, type: "sawtooth", gain: 0.25, slide: -180 }); noise({ dur: 0.5, gain: 0.18, freq: 600 }); },
  shout2()    { tone({ freq: 700, dur: 0.6, type: "sawtooth", gain: 0.22, slide: -500 }); noise({ dur: 0.5, gain: 0.2, freq: 2200 }); },
  shout3()    { tone({ freq: 90, dur: 0.9, type: "sine", gain: 0.18 }); tone({ freq: 100, dur: 0.9, type: "triangle", gain: 0.12, when: 0.1 }); },
  death()     { [400, 320, 240, 160, 80].forEach((f, i) => tone({ freq: f, dur: 0.25, type: "sawtooth", gain: 0.25, when: i * 0.18 })); },
  burp()      { tone({ freq: 90, dur: 0.3, type: "sawtooth", gain: 0.3, slide: 30 }); noise({ dur: 0.3, gain: 0.18, freq: 250, q: 0.5 }); },
  ui()        { tone({ freq: 1200, dur: 0.04, type: "square", gain: 0.08 }); },
  zone()      { [523, 659, 784].forEach((f, i) => tone({ freq: f, dur: 0.25, type: "triangle", gain: 0.16, when: i * 0.08 })); },
};
