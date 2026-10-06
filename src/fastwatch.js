/**
 * 快速盯梢：点名几款机型（比如 ROG + RTX 5090），每几分钟查一次 Best Buy，
 * 新上架 / 重新有货 / 降价时只要够便宜就立刻通知。**只提醒，不下单** —— 结账你自己点。
 *
 * 和「特别关注」的区别：特别关注只在已经在榜上的机器降价时判断，跟着 30 分钟一轮走；
 * 快速盯梢自己去查（频率高得多），而且新上架、补货也算 —— 超低价往往恰恰是
 * 新冒出来的 Open Box 或者刚补上的货，等下一轮全量查询就晚了。
 *
 * 「够便宜」满足任一条就报：
 *   1) 比 Best Buy 上**同显卡**的其他笔记本都便宜（只看有货、最近还见过的）
 *   2) 是降价，且降幅 ≥ minDropPercent（默认 10%）
 *   3) 低于你填的价位上限（可不填）
 */
import { gpuTier } from './analytics.js';

const LAPTOPS = 'abcat0502000';

/** 一条目标的默认值。gpu 是唯一必填项。 */
export const FAST_DEFAULTS = {
  enabled: true,
  name: '',
  brand: 'rog',            // 商品名里必须出现的词，空格分隔多个 = 全部要有；留空 = 不限品牌
  gpu: '',                 // 如 5090 / 5080 / 5070 Ti
  maxPrice: null,          // 低于这个价就报（留空不限）
  minDropPercent: 10,      // 降价时，降幅到这个百分比也报
  includeOpenBox: true,    // 连 Open Box 一起查（超低价大多在这里）
  ignoreQuietHours: false, // 免打扰时段也提醒
};

// 没被快速盯梢覆盖的行只靠 30 分钟一轮的全量查询刷新，参照窗口放宽到 48 小时
const OTHER_FRESH_MS = 48 * 3600e3;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (s) => String(s || '').toLowerCase().split(/\s+/).filter(Boolean);

/** 统一显卡写法，方便和 specs.gpu 比：'rtx 5070 ti' → '5070 TI' */
export function normGpu(gpu) {
  return gpuTier({ gpu: String(gpu || '').trim().replace(/^(?:rtx|gtx)\s*/i, '') });
}

/** 这一行是哪条目标盯的？只认 Best Buy 的笔记本。没有返回 null */
export function matchTarget(row, targets = []) {
  if (!row || (row.retailer || 'bestbuy') !== 'bestbuy') return null;
  if (row.specs?.form !== 'laptop') return null;
  const g = gpuTier(row.specs);
  if (!g) return null;
  const hay = [row.name, row.specs?.shortName, row.specs?.brand, row.manufacturer].filter(Boolean).join(' ');
  for (const t of targets) {
    if (t.enabled === false || normGpu(t.gpu) !== g) continue;
    // 按整词匹配：rog 不该匹配到 progressive 之类
    if (!words(t.brand).every((w) => new RegExp(`\\b${escapeRe(w)}\\b`, 'i').test(hay))) continue;
    return t;
  }
  return null;
}

/**
 * Best Buy 上和它同显卡、有货、最近还见过的其他笔记本里，最便宜的那台。
 *
 * 「最近」分两种：被快速盯梢覆盖的行几分钟就刷新一次，超过 3 个间隔（至少 15 分钟）
 * 没再出现，多半已经卖掉或下架了（Open Box 尤其如此），不能还拿它当参照 ——
 * 不然一台早就卖掉的低价 Open Box 会把后面所有真好价都压住。
 * 其他行只靠全量查询刷新，放宽到 48 小时。
 */
export function cheapestOther(row, rows, { targets = [], intervalMinutes = 4, now = Date.now() } = {}) {
  const g = gpuTier(row.specs);
  if (!g) return null;
  const fastWindow = Math.max(15 * 60e3, 3 * (Number(intervalMinutes) || 4) * 60e3);
  let best = null;
  for (const o of rows) {
    if (o.key === row.key) continue;
    if ((o.retailer || 'bestbuy') !== 'bestbuy') continue;
    if (o.specs?.form !== 'laptop' || gpuTier(o.specs) !== g) continue;
    if (o.inStock === false || o.price == null) continue;
    const window = matchTarget(o, targets) ? fastWindow : OTHER_FRESH_MS;
    if (now - (o.lastSeenAt || 0) > window) continue;
    if (!best || o.price < best.price) best = o;
  }
  return best;
}

/**
 * 这次变化够不够报。
 *
 * @param change { type: 'found' | 'drop' | 'restock', pct? }
 * @param ctx    { rows, targets, intervalMinutes, primed, now? }
 *               primed = 这条目标已经完整查过一轮。第一轮是摸底：
 *               榜上没有的全会算「新上架」，那不是降价，是我们第一次看见，不报。
 * @returns { reason } 或 null
 */
export function judgeHit(row, change, target, ctx = {}) {
  if (!row || !change || !target) return null;
  if (row.inStock === false || row.price == null) return null;   // 没货的降价没法下手
  if (change.type === 'found' && !ctx.primed) return null;

  const reasons = [];
  if (target.maxPrice != null && row.price <= target.maxPrice) {
    reasons.push(`低于你的价位 $${target.maxPrice}`);
  }
  const other = cheapestOther(row, ctx.rows || [], ctx);
  if (other && row.price < other.price) {
    reasons.push(`Best Buy 同显卡笔记本里最便宜（第二便宜 $${other.price}）`);
  }
  const minDrop = target.minDropPercent ?? FAST_DEFAULTS.minDropPercent;
  if (change.type === 'drop' && (change.pct ?? 0) >= minDrop) {
    reasons.push(`降幅 ≥ ${minDrop}%`);
  }
  if (!reasons.length) return null;

  const what = change.type === 'found' ? '新上架' : change.type === 'restock' ? '重新有货' : null;
  const cond = row.condition && row.condition !== 'New' ? row.condition : null;
  // Marketplace 三方卖家的退换货政策和自营不一样，通知里说清楚，下单前自己掂量
  const seller = row.thirdParty ? '三方卖家' : null;
  return { reason: [cond, seller, what, ...reasons].filter(Boolean).join(' · ') };
}

/** 命中后给通知用的 alertHit。和特别关注同一个形状，通知那边不用分两套 */
export function toAlertHit(target, fastHit, alsoHit = null) {
  return {
    keyword: target.name,
    title: `⚡ 快速盯梢：${target.name}`,
    note: fastHit.reason,
    ignoreQuietHours: !!(target.ignoreQuietHours || alsoHit?.ignoreQuietHours),
    fast: true,
  };
}

/**
 * 一条目标对应的搜索：全新一条，Open Box 一条，各只看第 1 页、按价格从低到高。
 * 同一款旗舰在 Best Buy 上就那么几个 SKU，一页足够。
 */
export function searchesFor(t) {
  const base = {
    kind: 'computer',
    retailer: 'bestbuy',
    categoryId: LAPTOPS,
    keywords: [t.brand, `rtx ${t.gpu}`].filter(Boolean).join(' ').toLowerCase(),
    condition: 'any',
    sort: 'salePrice.asc',
    limit: 30,
    maxPages: 1,
    enabled: true,
  };
  const out = [{ ...base, id: `fast-${t.id}`, name: `快速盯梢 · ${t.name}` }];
  if (t.includeOpenBox !== false) {
    out.push({
      ...base,
      id: `fast-${t.id}-ob`,
      name: `快速盯梢 · ${t.name} · Open Box`,
      channel: 'openbox',
      condition: 'openbox',
    });
  }
  return out;
}

/** 规范化一条目标（界面传上来的可能缺字段 / 类型不对） */
export function normalizeTarget(input = {}, id) {
  const numOrNull = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const gpu = String(input.gpu || '').trim().replace(/^(?:rtx|gtx)\s*/i, '').replace(/\s+/g, ' ');
  const brand = String(input.brand ?? FAST_DEFAULTS.brand).trim().toLowerCase().replace(/\s+/g, ' ');
  const t = {
    ...FAST_DEFAULTS,
    ...input,
    id: id || input.id,
    enabled: input.enabled !== false,
    brand,
    gpu,
    maxPrice: numOrNull(input.maxPrice),
    minDropPercent: numOrNull(input.minDropPercent) ?? FAST_DEFAULTS.minDropPercent,
    includeOpenBox: input.includeOpenBox !== false,
    ignoreQuietHours: !!input.ignoreQuietHours,
  };
  t.name = String(input.name || '').trim() || [brand.toUpperCase(), `RTX ${gpu.toUpperCase().replace(/ TI$/, ' Ti')}`].filter(Boolean).join(' · ');
  return t;
}

/** 显卡写法对不对：4 位数字，可带 Ti / Super */
export function validGpu(gpu) {
  return /^\d{4}(?: ?(?:ti|super|ti super))?$/i.test(String(gpu || '').trim().replace(/^(?:rtx|gtx)\s*/i, ''));
}
