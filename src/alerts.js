/**
 * 特别关注：盯住某个品牌或某台机器，大降价时第一时间通知。
 *
 * 为什么要单独一层，而不是复用全局的 dropMinPercent/dropMinAmount：
 * 全局阈值是「降这么多才值得打扰我」，特别关注是「这台我盯着，标准另算」。
 * 两者方向相反 —— 全局设 10% 时，你给幻14 设的 5% 会被全局先吞掉；
 * 反过来全局设 0 时，满屏小波动又会把真正关心的那条淹掉。
 * 所以规则命中时**绕开全局闸门**，并且在通知里单独成条、不受每轮上限压制。
 */

/** 一条规则的默认值。keyword 是唯一必填项。 */
export const ALERT_DEFAULTS = {
  enabled: true,
  keyword: '',          // 品牌或型号，空格分隔多个词 = 全部命中才算（和榜单搜索一致）
  retailer: 'any',      // any | bestbuy | bh | amazon
  minPercent: 15,       // 降幅 ≥ 这个百分比才提醒
  minAmount: 0,         // 且降幅 ≥ 这个金额
  maxPrice: null,       // 只关心低于这个价的（留空不限）
  ignoreQuietHours: false,  // 免打扰时段也要弹（真在等的机器才开）
  note: '',
};

/**
 * 这条降价命中了哪条规则？返回命中的规则，没命中返回 null。
 *
 * @param row   本次变价的商品（要有 name/specs/retailer/price）
 * @param drop  { pct, delta } 本次降幅
 */
export function matchAlert(row, drop, alerts = []) {
  if (!row || !drop) return null;
  const hay = [
    row.name,
    row.specs?.shortName,
    row.specs?.brand,
    row.manufacturer,
    row.sku,
  ].filter(Boolean).join(' ').toLowerCase();

  for (const a of alerts) {
    if (a.enabled === false) continue;
    const kw = String(a.keyword || '').trim().toLowerCase();
    if (!kw) continue;
    // 多个词全部命中才算，和榜单搜索框一个规矩
    if (!kw.split(/\s+/).every((w) => hay.includes(w))) continue;

    if (a.retailer && a.retailer !== 'any' && (row.retailer || 'bestbuy') !== a.retailer) continue;
    if (a.maxPrice != null && row.price != null && row.price > a.maxPrice) continue;
    if ((drop.pct ?? 0) < (a.minPercent ?? 0)) continue;
    if ((drop.delta ?? 0) < (a.minAmount ?? 0)) continue;
    return a;
  }
  return null;
}

/** 规范化一条规则（界面传上来的可能缺字段/类型不对） */
export function normalizeAlert(input = {}, id) {
  const numOrNull = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    ...ALERT_DEFAULTS,
    ...input,
    id: id || input.id,
    enabled: input.enabled !== false,
    keyword: String(input.keyword || '').trim(),
    retailer: ['bestbuy', 'bh', 'amazon'].includes(input.retailer) ? input.retailer : 'any',
    minPercent: numOrNull(input.minPercent) ?? 0,
    minAmount: numOrNull(input.minAmount) ?? 0,
    maxPrice: numOrNull(input.maxPrice),
    ignoreQuietHours: !!input.ignoreQuietHours,
    note: String(input.note || '').slice(0, 120),
  };
}
