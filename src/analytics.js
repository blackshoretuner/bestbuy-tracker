/**
 * 值不值的两把尺子。
 *
 * 1) 同档横向分位 —— 「同配置的机器现在都卖多少，这台排第几」
 *    折扣百分比是最没用的指标：Best Buy 的 regularPrice 常年虚高，
 *    -40% 可能只是虚标。真正有意义的是拿同配置的实际在售价互相比。
 *
 * 2) 自身历史分位 —— 「这个价在它自己的历史里算低吗」
 *    "比上次低"完全不够：从 $2000 涨到 $2400 再跌回 $2300 也是"降价"。
 *    要看的是当前价在过去 N 天价格分布里的位置，而且要按**时间加权**：
 *    一个价格挂了 80 天和只挂了 2 小时，权重不该一样。
 *
 * 两把尺子都会明确报告「样本/历史够不够」。宁可说"数据不足"，
 * 也不吐一个看着像那么回事、实际没有统计意义的数字。
 */
import { num } from './util.js';

/* ------------------------------------------------------------------ */
/* 配置归一化                                                           */
/* ------------------------------------------------------------------ */

/** 显卡档位。核显是一个合法档位，不是"缺失"。 */
export function gpuTier(specs) {
  const g = specs?.gpu;
  if (!g) return null;
  if (g === '核显') return 'igpu';
  return String(g).toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * CPU 档位。同一个显卡档下，CPU 仍然能拉开几百刀，
 * 核显机更是全靠 CPU 定价，所以必须作为一个分组维度。
 */
export function cpuTier(specs) {
  const c = String(specs?.cpu || '').trim();
  if (!c) return null;
  const fam = c.split(/\s+/)[0];

  if (/^M[1-9]$/.test(fam)) return /Pro|Max|Ultra/i.test(c) ? 'high' : 'mid';
  if (/^(i9|u9|r9|rAI9)$/i.test(fam)) return 'high';
  if (/^(i7|u7|r7|rAI7)$/i.test(fam)) return 'mid';
  if (/^(i5|u5|r5|rAI5)$/i.test(fam)) return 'entry';
  if (/^(i3|u3|r3)$/i.test(fam)) return 'low';
  if (/^SDX$/i.test(fam)) return /Elite/i.test(c) ? 'mid' : 'entry';
  if (/^(cel|pen|ato|MTK)$/i.test(fam)) return 'low';
  return null;
}

const CPU_TIER_LABEL = { high: '旗舰U', mid: '高端U', entry: '主流U', low: '入门U' };

export function ramGb(specs) {
  return num(String(specs?.ram || '').match(/(\d+)G/)?.[1]);
}

export function diskGb(specs) {
  const s = String(specs?.disk || '');
  const m = s.match(/([\d.]+)([GT])/);
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'T' ? 1000 : 1);
}

function fmtDisk(gb) {
  if (!gb) return '?';
  return gb >= 1000 ? `${gb / 1000}T` : `${gb}G`;
}

const FORM_LABEL = { laptop: '笔电', desktop: '台式', aio: '一体机' };

/**
 * 从细到粗的分组阶梯。取样本量够的最细一层。
 * 每一层都带 label，UI 要让用户看见"到底跟谁比的"。
 */
export function tierLadder(specs) {
  const form = specs?.form;
  const g = gpuTier(specs);
  const c = cpuTier(specs);
  const r = ramGb(specs);
  const d = diskGb(specs);
  if (!form || !g) return [];

  const gLabel = g === 'igpu' ? '核显' : g;
  const fLabel = FORM_LABEL[form] || form;
  const out = [];

  if (r && d) {
    out.push({ level: 4, key: `${form}|${g}|${r}|${d}`, label: `${fLabel} · ${gLabel} · ${r}G · ${fmtDisk(d)}` });
  }
  if (r) {
    out.push({ level: 3, key: `${form}|${g}|${r}`, label: `${fLabel} · ${gLabel} · ${r}G` });
  }
  if (c) {
    out.push({ level: 2, key: `${form}|${g}|cpu:${c}`, label: `${fLabel} · ${gLabel} · ${CPU_TIER_LABEL[c]}` });
  }
  out.push({ level: 1, key: `${form}|${g}`, label: `${fLabel} · ${gLabel}` });
  return out;
}

/* ------------------------------------------------------------------ */
/* 同档横向对比                                                         */
/* ------------------------------------------------------------------ */

/** 把整个榜单按各层 key 建索引，一次建好给所有行复用 */
export function buildTierIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    if (row.price == null) continue;
    for (const t of tierLadder(row.specs)) {
      let bucket = index.get(t.key);
      if (!bucket) index.set(t.key, (bucket = { label: t.label, level: t.level, rows: [] }));
      bucket.rows.push(row);
    }
  }
  for (const bucket of index.values()) bucket.rows.sort((a, b) => a.price - b.price);
  return index;
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 这台在同档里排第几、比中位便宜多少、同档还有哪些更便宜的。
 * @returns null 表示所有层的样本量都不够，说不出话
 */
export function crossSection(row, index, { minN = 5, maxAlts = 3 } = {}) {
  if (row.price == null) return null;

  for (const t of tierLadder(row.specs)) {
    const bucket = index.get(t.key);
    if (!bucket || bucket.rows.length < minN) continue;

    const peers = bucket.rows;
    const prices = peers.map((p) => p.price);
    const cheaperOrEqual = prices.filter((p) => p <= row.price).length;
    // 越小越便宜：0 表示同档最便宜
    const pct = Math.round(((cheaperOrEqual - 1) / Math.max(1, peers.length - 1)) * 100);
    const med = median(prices);

    return {
      level: t.level,
      label: bucket.label,
      n: peers.length,
      rank: prices.filter((p) => p < row.price).length + 1,
      pct: Math.max(0, Math.min(100, pct)),
      min: prices[0],
      median: med,
      vsMedian: med ? Math.round((row.price - med) * 100) / 100 : null,
      // 同档更便宜的几台，直接给出替代选项 —— 这才是能立刻拿来用的信息
      cheaper: peers
        .filter((p) => p.price < row.price && p.key !== row.key)
        .slice(0, maxAlts)
        .map((p) => ({ key: p.key, sku: p.sku, name: p.specs?.shortName || p.name, price: p.price })),
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 自身历史分位（时间加权）                                              */
/* ------------------------------------------------------------------ */

/**
 * 价格点是"变化时才记一条"的阶梯序列，所以要按每段价格**持续的时长**加权。
 * 采样点密度会随查询频率变化，按点数算等于让高频采样的时段权重虚高。
 *
 * @param points [{t, p}] 按时间升序
 * @returns {pct, days, levels, min, max, enough, reason}
 *          pct 越小越好：0 = 历史最低，100 = 历史最高
 */
export function historyPercentile(points, price, opts = {}) {
  const { windowDays = 90, minDays = 3, minLevels = 2, now = Date.now() } = opts;
  const from = now - windowDays * 86400000;

  if (!points?.length || price == null) {
    return { pct: null, enough: false, reason: '还没有价格历史', days: 0, levels: 0 };
  }

  // 裁到窗口内。窗口起点之前的最后一个价格要保留成起始状态，
  // 否则一台跟踪很久、价格一直没变的机器会被当成"没有历史"。
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const segments = [];
  let carry = null;
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const end = i + 1 < sorted.length ? sorted[i + 1].t : now;
    if (end <= from) { carry = cur; continue; }
    segments.push({ p: cur.p, from: Math.max(cur.t, from), to: Math.min(end, now) });
  }
  if (!segments.length && carry) segments.push({ p: carry.p, from, to: now });
  else if (carry && segments.length && segments[0].from > from) {
    segments.unshift({ p: carry.p, from, to: segments[0].from });
  }

  let total = 0;
  let atOrBelow = 0;
  let min = Infinity;
  let max = -Infinity;
  const levels = new Set();

  for (const s of segments) {
    const dur = Math.max(0, s.to - s.from);
    if (!dur) continue;
    total += dur;
    if (s.p <= price) atOrBelow += dur;
    if (s.p < min) min = s.p;
    if (s.p > max) max = s.p;
    levels.add(Math.round(s.p * 100));
  }

  const days = total / 86400000;

  if (days < minDays) {
    return {
      pct: null, enough: false, days: Math.round(days * 10) / 10, levels: levels.size,
      reason: `才跟踪 ${days < 1 ? Math.round(days * 24) + ' 小时' : Math.round(days) + ' 天'}，还不够`,
    };
  }
  if (levels.size < minLevels) {
    // 价格从没动过。此时"100% 的时间都 ≤ 当前价"在数学上没错，
    // 但拿它当"历史高位"就是胡说，所以直接判定为数据不足。
    return {
      pct: null, enough: false, days: Math.round(days * 10) / 10, levels: levels.size,
      reason: `跟踪 ${Math.round(days)} 天内价格从没变过`,
    };
  }

  return {
    pct: Math.round((atOrBelow / total) * 100),
    enough: true,
    days: Math.round(days * 10) / 10,
    levels: levels.size,
    min: min === Infinity ? null : min,
    max: max === -Infinity ? null : max,
    reason: null,
  };
}

/* ------------------------------------------------------------------ */
/* 综合                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把两把尺子合成一个分数。只有两个维度都有数据才给分 ——
 * 只知道其中一个就打分，等于拿半个证据装成完整结论。
 */
export function dealScore(cross, hist) {
  const hasHist = hist?.enough && hist.pct != null;
  const hasCross = cross && cross.n >= 5;
  if (!hasHist && !hasCross) return null;

  if (hasHist && hasCross) {
    return {
      score: Math.round(0.6 * (100 - hist.pct) + 0.4 * (100 - cross.pct)),
      basis: 'both',
      // 对自己是低价，对同行也不贵 —— 两个条件都满足才叫真好价
      trueDeal: hist.pct <= 15 && cross.pct <= 35,
    };
  }

  // 只有一半证据的，分数压到 70 封顶。不压的话，一台"同档没样本、
  // 只是自己历史上便宜"的机器能拿 95 分，排在证据完整的真好价前面 ——
  // 那等于拿半个证据冒充完整结论。
  const SINGLE_MAX = 70;
  if (hasHist) {
    return { score: Math.round((100 - hist.pct) * (SINGLE_MAX / 100)), basis: 'hist', trueDeal: false };
  }
  return { score: Math.round((100 - cross.pct) * (SINGLE_MAX / 100)), basis: 'cross', trueDeal: false };
}
