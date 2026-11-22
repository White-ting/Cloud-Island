// 量录音的后半截：网页（web/ears.js）把她的语音条、电话里每一句量好（时长、停顿、音高、起伏…），
// 这里把数核一遍、跟她平时比，写成一行〔测量〕跟着她的话交给 TA。只写客观的数和「比平时高/快」，不替 TA 判断情绪。
// 写法和阈值照作者私用的另一个前端里那一套。
// 她平时的样子存在 DATA_DIR/voice-baseline.json（权限 600）：只攒语音条（最近 40 条），攒够 5 条才开始比；
// 电话那头开着回声消除，声音跟语音条不一样，所以电话只比、不攒。
import fs from 'node:fs';
import path from 'node:path';

const KEEP = 40, MIN = 5;
// 网页送来的数：名字 → [最小, 最大]。不在这里的一律扔掉，超出范围的整条不要
const FIELDS = {
  duration: [0, 3600], speech: [0, 3600], span: [0, 3600], pause_count: [0, 10000], pause_longest: [0, 3600],
  loud_db: [-200, 10], loud_range_db: [0, 200], loud_trend_db: [-200, 200],
  pitch_hz: [0, 2000], pitch_p10_hz: [0, 2000], pitch_p90_hz: [0, 2000], pitch_sd_st: [0, 100], tail_st: [-100, 100], pitched_ratio: [0, 1],
};
const NEED = ['duration', 'speech', 'pause_count', 'pause_longest', 'loud_trend_db', 'pitch_hz', 'pitch_sd_st', 'tail_st'];

// 核一遍网页送来的数：缺必要的、不是数、超出范围 → null（照样发语音，只是不带测量）
export function cleanMeas(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const o = {};
  for (const [k, [lo, hi]] of Object.entries(FIELDS)) {
    if (m[k] === undefined) continue;
    const v = Number(m[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) return null;
    o[k] = v;
  }
  return NEED.every((k) => k in o) ? o : null;
}

// 说了多少「字」：汉字一个算一个，英文、数字按词算
export const countWords = (text) => (String(text || '').match(/[一-鿿]/g) || []).length + (String(text || '').match(/[A-Za-z0-9]+/g) || []).length;

// 把数写成一行人话。阈值是普通说话的大致范围，不是她本人的（跟她本人比的在 compare 里）
export function measText(m, text = '') {
  const out = [`${m.duration.toFixed(1)} 秒`];
  const n = countWords(text);
  if (n >= 3) {
    const rate = n / Math.max(0.5, m.speech);
    out.push(`语速 ${rate.toFixed(1)} 字/秒（${rate > 5.5 ? '偏快' : rate < 3 ? '偏慢' : '正常'}）`);
  }
  out.push(m.pause_count ? `停顿 ${m.pause_count} 处，最长 ${m.pause_longest.toFixed(1)} 秒` : '一口气没停');
  if (m.pitch_hz) {
    const sd = m.pitch_sd_st;
    let p = `音高约 ${Math.round(m.pitch_hz)} Hz，${sd < 1.5 ? '平平的' : sd < 3 ? '有起伏' : '起伏很大'}`;
    if (m.tail_st > 1.5) p += '，句尾上扬';
    else if (m.tail_st < -1.5) p += '，句尾往下沉';
    out.push(p);
  }
  if (m.loud_trend_db <= -4) out.push('后半段声音变轻');
  else if (m.loud_trend_db >= 4) out.push('后半段声音变响');
  return out.join(' · ');
}

const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

export function openEars({ dir, now = Date.now }) {
  const file = path.join(dir, 'voice-baseline.json');
  const read = () => { try { const a = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } };
  // 跟她平时比：回「比她平时：…」（攒的不够 5 条回空）。keep：这条攒进去（电话传 false）
  function compare(m, text, keep = true) {
    const n = countWords(text);
    const rate = n >= 3 ? n / Math.max(0.5, m.speech) : null;
    const hist = read(), out = [];
    if (hist.length >= MIN) {
      const hz = med(hist.map((h) => h.hz));
      if (hz && m.pitch_hz) {
        const d = 12 * Math.log2(m.pitch_hz / hz);
        if (Math.abs(d) >= 1.5) out.push(`声音比平时${d > 0 ? '高' : '低'}`);
      }
      const sd = med(hist.map((h) => h.sd));
      if (sd && m.pitch_hz) {
        if (m.pitch_sd_st > sd * 1.5) out.push('起伏比平时大');
        else if (m.pitch_sd_st < sd * 0.6) out.push('比平时平');
      }
      const r0 = med(hist.map((h) => h.rate));
      if (r0 && rate) {
        if (rate > r0 * 1.2) out.push('说得比平时快');
        else if (rate < r0 * 0.8) out.push('说得比平时慢');
      }
      if (!out.length) out.push('和平时差不多');
    }
    if (keep) {
      hist.push({ hz: m.pitch_hz || null, sd: m.pitch_hz ? m.pitch_sd_st : null, rate: rate ? Math.round(rate * 100) / 100 : null, at: now() });
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file + '.tmp', JSON.stringify(hist.slice(-KEEP)), { mode: 0o600 });
        fs.renameSync(file + '.tmp', file);
      } catch { /* 攒不进去就下次再攒，不耽误这句 */ }
    }
    return out.length ? '比她平时：' + out.join('、') : '';
  }
  // 一整行（不带〔测量〕三个字）。m 要先过 cleanMeas
  function line(m, text, { keep = true } = {}) {
    const c = compare(m, text, keep);
    return measText(m, text) + (c ? ' · ' + c : '');
  }
  return { line, compare, file };
}
