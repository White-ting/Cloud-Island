/* 量录音：给她发来的语音条、电话里的每一句「量尺寸」——时长、有声时长、停顿、音量起伏、音高高低和起伏、句尾上扬还是下沉。
   只量客观的数，不判断情绪；量好的数交给后端，后端跟她平时比、写成一行〔测量〕带给 TA。
   在浏览器里量（不用装任何东西）：录音解开成波形，转成 16k 单声道；每 10 毫秒一帧（窗 50 毫秒）算音量（dBFS）和音高（YIN，70–1000 Hz）。
   有声 = 比底噪高 10 dB 且不低于 -50 dBFS；两段有声之间空了 ≥ 0.25 秒算一次停顿（头尾的静音不算）。
   算法照作者私用的一个 macOS 小工具（Swift）改写成 JavaScript，同一段录音量出来的数一样。
   用法：YDEars.blob(录音 Blob) → Promise<量好的数 | null>；YDEars.pcm(Float32Array, 采样率) → 量好的数（测试用） */
(function (g) {
  'use strict';
  const SR = 16000, HOP = 160, WIN = 800, TAU_MIN = Math.floor(SR / 1000), TAU_MAX = Math.floor(SR / 70);
  const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100;
  const pct = (v, p) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * p)))]; };
  const avg = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

  // 转成 16k：先按比例取平均（顺带滤掉高频），再线性插值
  function to16k(x, sr) {
    if (sr === SR) return x;
    const n = Math.floor(x.length * SR / sr), out = new Float32Array(n), step = sr / SR;
    for (let i = 0; i < n; i++) {
      const a = i * step, lo = Math.floor(a), hi = Math.min(x.length, Math.max(lo + 1, Math.floor(a + step)));
      let s = 0; for (let j = lo; j < hi; j++) s += x[j];
      out[i] = s / (hi - lo);
    }
    return out;
  }

  // YIN：回基频（Hz），不像就回 0
  const d = new Float64Array(TAU_MAX + 1), cm = new Float64Array(TAU_MAX + 1);
  function yin(x, b) {
    const w = WIN;
    for (let tau = 1; tau <= TAU_MAX; tau++) {
      let s = 0;
      for (let j = 0; j < w; j++) { const v = x[b + j] - x[b + j + tau]; s += v * v; }
      d[tau] = s;
    }
    let run = 0;
    cm[0] = 1;
    for (let tau = 1; tau <= TAU_MAX; tau++) { run += d[tau]; cm[tau] = run > 0 ? d[tau] * tau / run : 1; }
    for (let tau = TAU_MIN; tau < TAU_MAX; tau++) {
      if (cm[tau] < 0.15) {
        while (tau + 1 < TAU_MAX && cm[tau + 1] < cm[tau]) tau++;
        const a = cm[tau - 1], bb = cm[tau], c = cm[tau + 1], den = a - 2 * bb + c; // 抛物线插值
        return SR / (den !== 0 ? tau + 0.5 * (a - c) / den : tau);
      }
    }
    return 0;
  }

  function pcm(samples, sr) {
    const x = to16k(samples, sr);
    if (x.length <= SR * 0.3) return null;
    const db = [], f0 = [];
    for (let i = 0; i + WIN + TAU_MAX < x.length; i += HOP) {
      let s = 0;
      for (let j = i; j < i + WIN; j++) s += x[j] * x[j];
      const v = 10 * Math.log10(Math.max(s / WIN, 1e-10));
      db.push(v);
      f0.push(v > -50 ? yin(x, i) : 0);
    }
    const frameSec = HOP / SR, duration = r1(x.length / SR);
    const thr = Math.max(pct(db, 0.1) + 10, -50);
    const voiced = db.map((v) => v > thr);
    const first = voiced.indexOf(true), last = voiced.lastIndexOf(true);
    if (first < 0) return { ok: true, duration, voiced: false };
    const pauses = [];
    for (let k = first, gs = -1; k <= last; k++) {
      if (!voiced[k]) { if (gs < 0) gs = k; }
      else if (gs >= 0) { const len = (k - gs) * frameSec; if (len >= 0.25) pauses.push([r1(gs * frameSec), r2(len)]); gs = -1; }
    }
    const span = (last - first + 1) * frameSec;
    const speech = Math.max(0.1, span - pauses.reduce((a, p) => a + p[1], 0));
    const idx = (a, b) => { const o = []; for (let k = a; k <= b; k++) o.push(k); return o; };
    const vdb = idx(first, last).filter((k) => voiced[k]).map((k) => db[k]);
    const mid = Math.floor((first + last) / 2);
    const half1 = idx(first, mid).filter((k) => voiced[k]).map((k) => db[k]);
    const half2 = idx(mid + 1, Math.max(mid + 1, last)).filter((k) => voiced[k]).map((k) => db[k]);
    const pf = idx(first, last).filter((k) => voiced[k] && f0[k] > 0).map((k) => f0[k]);
    const st = pf.map((f) => 12 * Math.log2(f / 100)); // 换成半音（相对 100 Hz）算起伏
    const mean = avg(st);
    const sd = st.length ? Math.sqrt(st.reduce((a, v) => a + (v - mean) ** 2, 0) / st.length) : 0;
    // 句尾：最后 0.5 秒有声帧的音高 vs 整体中位，差几个半音
    const tail = idx(Math.max(first, last - Math.floor(0.5 / frameSec)), last).filter((k) => voiced[k] && f0[k] > 0).map((k) => 12 * Math.log2(f0[k] / 100));
    const tailDiff = tail.length >= 5 ? pct(tail, 0.5) - pct(st, 0.5) : 0;
    return {
      ok: true, duration, voiced: true, span: r1(span), speech: r1(speech),
      pauses, pause_count: pauses.length, pause_longest: r2(Math.max(0, ...pauses.map((p) => p[1]))),
      loud_db: r1(avg(vdb)), loud_range_db: r1(pct(vdb, 0.9) - pct(vdb, 0.1)), loud_trend_db: r1(avg(half2) - avg(half1)),
      pitch_hz: pf.length ? r1(pct(pf, 0.5)) : 0, pitch_p10_hz: r1(pct(pf, 0.1)), pitch_p90_hz: r1(pct(pf, 0.9)),
      pitch_sd_st: r2(sd), tail_st: r2(tailDiff), pitched_ratio: r2(pf.length / Math.max(1, vdb.length)),
    };
  }

  // 16k 单声道 16 位的 wav（给「听语气」的模型：各家都收 wav，iPhone 录的 m4a、Chrome 录的 webm 不一定收）
  function wav(samples, sr) {
    const x = to16k(samples, sr), b = new ArrayBuffer(44 + x.length * 2), v = new DataView(b);
    const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, x.length * 2, true);
    for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), true);
    return b;
  }

  // 录音 Blob → { meas: 量好的数, wav: wav 的 Blob（要了才有）}。解不开（有的浏览器解不了自己录的格式）、出错一律回 null，不耽误发语音
  async function read(b, { withWav = false } = {}) {
    try {
      const AC = g.AudioContext || g.webkitAudioContext;
      if (!AC || !b) return null;
      const ac = new AC(), buf = await b.arrayBuffer();
      let ab;
      try { ab = await new Promise((ok, no) => { const p = ac.decodeAudioData(buf, ok, no); if (p && p.then) p.then(ok, no); }); }
      finally { try { const p = ac.close(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* 关不掉无所谓 */ } }
      const n = ab.length, ch = ab.numberOfChannels, mono = new Float32Array(n);
      for (let c = 0; c < ch; c++) { const a = ab.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += a[i] / ch; }
      await new Promise((ok) => setTimeout(ok, 0)); // 让页面先喘口气
      return { meas: pcm(mono, ab.sampleRate), wav: withWav && g.Blob ? new g.Blob([wav(mono, ab.sampleRate)], { type: 'audio/wav' }) : null };
    } catch (e) { return null; }
  }
  const blob = (b) => read(b).then((r) => (r ? r.meas : null));

  g.YDEars = { pcm, wav, blob, read };
})(typeof self !== 'undefined' ? self : globalThis);
