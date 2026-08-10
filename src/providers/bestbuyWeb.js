/**
 * 网页通道：不需要任何 API Key。
 *
 * 用本机的 Edge/Chrome 开一个后台实例去读 Best Buy 的搜索结果页，
 * 从商品卡里提取 sku / 名称 / 现价 / 原价 / 品相。因为是真浏览器，
 * 页面能正常渲染，不会像裸 fetch 那样被挡在挑战页外面。
 *
 * 规矩：
 *  - 请求之间强制间隔（默认 2.5s），一轮最多翻几页，不做并发
 *  - 遇到挑战页/验证码立刻停手并如实报错，绝不尝试绕过或识别验证码
 *  - 只读公开的商品价格，不登录、不下单、不碰账号
 */
import { Browser, BrowserError } from '../browser/cdp.js';
import { extractSpecs } from '../specs.js';
import { log, money, num, sleep } from '../util.js';

const ORIGIN = 'https://www.bestbuy.com';

/* 我们的分类 ID → 搜索关键词。搜索页比分类落地页稳定得多，
   分类落地页现在只是个导航壳子，根本不出商品。 */
const CATEGORY_TERMS = {
  abcat0502000: 'laptop',
  abcat0501000: 'desktop computer',
  abcat0513000: 'all in one computer',
  abcat0500000: 'computer',
  abcat0507000: 'monitor',
};

const CONDITION_FACET = {
  openbox: 'Open-Box',
  refurbished: 'Refurbished',
  preowned: 'Pre-Owned',
};

export class BlockedError extends Error {
  constructor(detail) {
    super(`Best Buy 挡住了这次访问${detail ? `：${detail}` : ''}。已停止，不做绕过尝试。`);
    this.code = 'BLOCKED';
  }
}

/* ------------------------------------------------------------------ */
/* URL                                                                 */
/* ------------------------------------------------------------------ */
export function buildSearchUrl({ categoryId, keywords, condition, page = 1 }) {
  const terms = [];
  const catTerm = categoryId ? CATEGORY_TERMS[categoryId] : null;
  if (catTerm) terms.push(catTerm);
  if (keywords) terms.push(String(keywords).trim());
  const st = terms.join(' ').trim() || 'laptop';

  const u = new URL('/site/searchpage.jsp', ORIGIN);
  u.searchParams.set('st', st);
  u.searchParams.set('intl', 'nosplash');
  if (page > 1) u.searchParams.set('cp', String(page));

  const facet = CONDITION_FACET[condition];
  if (facet) u.searchParams.set('qp', `condition_facet=Condition~${facet}`);

  return u.toString();
}

export function productUrl(sku) {
  return `${ORIGIN}/site/-/${sku}.p?skuId=${sku}`;
}

/* ------------------------------------------------------------------ */
/* 页面内提取脚本                                                       */
/* ------------------------------------------------------------------ */

/* 锚点用的是语义稳定的东西：商品链接里的 /sku/<数字>，以及卡片里的
   "$xx.xx" 和 "The price was" 文案。不依赖混淆过的 class 名。 */
const EXTRACT_LIST = String.raw`(() => {
  const toNum = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
  const out = [];
  const seen = new Set();

  for (const a of document.querySelectorAll('a[href*="/sku/"]')) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/\/sku\/(\d{6,9})/);
    if (!m) continue;
    const sku = m[1];
    if (seen.has(sku)) continue;

    // 往上找最小的、包含价格的祖先节点当作商品卡
    let card = null, node = a;
    for (let i = 0; i < 12 && node; i++, node = node.parentElement) {
      const t = node.innerText || '';
      if (/\$[\d,]+\.\d{2}/.test(t)) { card = node; if (t.length < 1400) break; }
    }
    if (!card) continue;
    const text = card.innerText || '';
    if (text.length > 3000) continue;   // 抓到整个网格了，不是单张卡
    seen.add(sku);

    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    // Best Buy 商品名都是 "品牌 - 型号 - 规格 - 规格" 结构，取含 " - " 的最长行
    const named = lines.filter(l => l.includes(' - ')).sort((x, y) => y.length - x.length);
    const name = named[0] || a.getAttribute('aria-label') || lines[0] || ('SKU ' + sku);

    const prices = [...text.matchAll(/\$([\d,]+\.\d{2})/g)].map(x => toNum(x[1]));
    const wasM = text.match(/(?:the price was|price was|was|comp\. at)\s*\$?\s*([\d,]+\.\d{2})/i);
    const saveM = text.match(/save\s*\$?\s*([\d,]+\.\d{2})/i);

    let price = prices.length ? prices[0] : null;
    let regular = wasM ? toNum(wasM[1]) : null;
    if (regular == null && saveM && price != null) regular = price + toNum(saveM[1]);
    if (regular != null && price != null && regular <= price) regular = null;
    if (price == null) continue;

    let condition = 'New';
    // 只认真正的品相等级。卡片上写的是 "Open-Box: as low as $172.99"，
    // 不加白名单就会把 "as low as" 当成品相。
    const ob = text.match(/Open-Box\s*[:\-]?\s*(Excellent|Certified|Satisfactory|Fair|Good)?/i);
    if (ob) {
      condition = ob[1] ? 'Open-Box (' + ob[1] + ')' : 'Open-Box';
    } else if (/refurbish/i.test(text)) condition = 'Refurbished';
    else if (/pre-?owned/i.test(text)) condition = 'Pre-Owned';

    const img = card.querySelector('img');
    const rate = text.match(/Rating\s+([\d.]+)\s+out of 5/i);
    const revs = text.match(/\((\d[\d,]*)\)/);

    out.push({
      sku,
      name,
      url: new URL(href, location.origin).href,
      image: img ? (img.currentSrc || img.src || null) : null,
      price,
      regularPrice: regular,
      condition,
      rating: rate ? Number(rate[1]) : null,
      reviews: revs ? Number(revs[1].replace(/,/g, '')) : null,
      inStock: !/sold out|currently unavailable|out of stock/i.test(text),
    });
  }
  return out;
})()`;

const COUNT_SKUS = String.raw`(() => new Set([...document.querySelectorAll('a[href*="/sku/"]')]
  .map(a => (a.getAttribute('href').match(/\/sku\/(\d{6,9})/) || [])[1]).filter(Boolean)).size)()`;

/* 注意：Best Buy 每个页面都内嵌一个隐藏的 enterprise reCAPTCHA anchor iframe，
   它的存在完全不代表被挑战。只有当验证码"可见"并且页面上一个商品都没有时，
   才算真的被拦。否则会把正常页面全判成被封。 */
const PAGE_HEALTH = String.raw`(() => {
  const t = (document.body && document.body.innerText || '').slice(0, 2500);
  const bigCaptcha = [...document.querySelectorAll('iframe[src*="captcha"], #px-captcha, [id*="challenge"]')]
    .some((f) => {
      const r = f.getBoundingClientRect();
      return r.width > 120 && r.height > 80;
    });
  return {
    title: document.title,
    blockedText: /access denied|are you a robot|unusual traffic|reference #\d|verify you are human|activity from your device/i.test(t),
    visibleCaptcha: bigCaptcha,
    hasProducts: !!document.querySelector('a[href*="/sku/"]'),
    noResults: /no results|0 items|did not match/i.test(t),
  };
})()`;

/**
 * 从商品全名或商品链接里，凑出一个能搜到这台机器的关键词。
 *
 * 为什么要这么绕：Best Buy 的**商品详情页**会拒绝这个客户端（返回连接错误，
 * 搜索页却完全正常），而按 SKU 精确搜索又会被重定向到详情页。所以想刷新
 * 某一台机器的价格，只能拿它的型号名去搜，再从结果里按 SKU 认领。
 */
export function searchTermFor({ name, url }) {
  if (name && /\s[-–—]\s/.test(name)) {
    const segs = name.split(/\s+[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
    // 品牌 + 型号段，再补一个能区分配置的规格段（内存/硬盘）
    const spec = segs.slice(2).find((s) => /\d+\s?(GB|TB)/i.test(s)) || '';
    return `${segs[0] || ''} ${segs[1] || ''} ${spec}`
      .replace(/["”]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 9)
      .join(' ');
  }
  // 退而求其次：从 /product/<slug>/ 里还原型号
  const slug = String(url || '').match(/\/product\/([^/]+)\//)?.[1];
  if (slug) {
    return slug.replace(/-/g, ' ').split(/\s+/).slice(0, 8).join(' ');
  }
  return String(name || '').split(/\s+/).slice(0, 8).join(' ');
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */
export class WebSession {
  constructor(settings = {}) {
    this.settings = settings;
    this.browser = null;
    this.page = null;
    this.loads = 0;
    this.lastLoadAt = 0;
  }

  async open() {
    if (this.browser) return;
    this.browser = await Browser.launch({
      exePath: this.settings.browserPath || undefined,
      headless: this.settings.browserHeadless !== false,
      width: 1600,
      height: 1200,
    });
    this.page = await this.browser.newPage({ width: 1600, height: 1200 });
  }

  async close() {
    if (!this.browser) return;
    try { await this.page?.close(); } catch { /* ignore */ }
    try { await this.browser.close(); } catch { /* ignore */ }
    this.browser = null;
    this.page = null;
    log.info(`浏览器已关闭（本轮加载了 ${this.loads} 个页面）`);
  }

  async #throttle() {
    const gap = Math.max(1200, this.settings.scrapeDelayMs || 2500);
    const wait = this.lastLoadAt + gap - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastLoadAt = Date.now();
  }

  async #load(url, { settleMs = 1500 } = {}) {
    await this.open();
    await this.#throttle();
    this.loads++;
    await this.page.goto(url, { timeout: this.settings.requestTimeoutMs || 45000, settleMs });
    const health = await this.page.evaluate(PAGE_HEALTH);
    // 有商品就是正常页面，别被隐藏的 recaptcha anchor 骗了
    const reallyBlocked = !health?.hasProducts && (health?.blockedText || health?.visibleCaptcha);
    if (reallyBlocked) {
      throw new BlockedError(health.visibleCaptcha ? '出现了验证码' : health.title || '挑战页');
    }
    return health;
  }

  /** 搜索：翻若干页，返回规格化后的商品数组 */
  async search(query) {
    const limit = Math.min(num(query.limit) || 40, 200);
    const maxPages = Math.max(1, Math.min(Number(query.maxPages) || 3, 8));
    const all = new Map();

    for (let page = 1; page <= maxPages; page++) {
      const url = buildSearchUrl({ ...query, page });
      let rows = [];
      let onPage = null;
      try {
        const health = await this.#load(url, { settleMs: 1800 });
        if (health?.noResults) break;

        // 懒加载：Best Buy 的商品网格是虚拟化的，得滚一遍才会渲染出来
        // 返回值是页面上出现过的商品链接数，用来和实际提取到的条数对比：
        // 两者差得多 = 提取逻辑漏了；两者都小 = 页面根本没加载出那么多。
        onPage = await this.page.scrollToLoadAll({ maxRounds: 12, stepPause: 400, countExpr: COUNT_SKUS });
        rows = (await this.page.evaluate(EXTRACT_LIST)) || [];
      } catch (e) {
        if (e.code === 'BLOCKED') throw e;         // 被拦了就整条中止
        // 单页超时/出错不该拖垮整条搜索，用已经拿到的结果继续
        log.warn(`搜索第 ${page} 页失败，跳过：${e.message}`);
        break;
      }
      if (!rows.length) break;

      let added = 0;
      for (const r of rows) {
        if (all.has(r.sku)) continue;
        all.set(r.sku, r);
        added++;
      }
      log.debug(
        `搜索页 ${page}：页面 ${onPage ?? '?'} 个商品链接 → 提取 ${rows.length} 台，` +
          `新增 ${added}（累计 ${all.size}）`
      );

      if (all.size >= limit || added === 0) break;
    }

    return [...all.values()].slice(0, limit).map((r) => normalize(r, 'web'));
  }

  /**
   * 刷新单台机器的价格。走搜索、按 SKU 认领，不碰详情页（详情页会被拒）。
   * 找不到就返回 null —— 宁可这一轮不更新，也不写入猜的价格。
   */
  async findBySku(sku, { name, url } = {}) {
    const term = searchTermFor({ name, url });
    if (!term) return null;
    const rows = await this.search({ keywords: term, limit: 60, maxPages: 2 });
    return rows.find((r) => r.sku === String(sku)) || null;
  }
}

/* ------------------------------------------------------------------ */
function normalize(r, source) {
  const price = money(r.price);
  const regular = money(r.regularPrice);
  const pct =
    regular && price != null && regular > price
      ? Math.round(((regular - price) / regular) * 1000) / 10
      : null;

  const base = {
    sku: String(r.sku),
    name: r.name || `SKU ${r.sku}`,
    image: r.image || null,
    url: r.url || productUrl(r.sku),
    addToCartUrl: null,
    manufacturer: null,
    modelNumber: null,
    condition: r.condition || 'New',
    category: null,
    price,
    regularPrice: regular,
    onSale: !!(regular && price != null && regular > price),
    percentOff: pct,
    dollarSavings: regular && price != null ? money(regular - price) : null,
    rating: r.rating ?? null,
    reviews: r.reviews ?? null,
    inStock: r.inStock !== false,
    source,
    details: Array.isArray(r.details) ? r.details : [],
  };
  base.specs = extractSpecs(base);
  // Best Buy 自营 SKU 是 7 位（6xxxxxx），Marketplace 第三方卖家是 8 位（1xxxxxxx）。
  // 第三方的退换货政策和自营不一样，标出来让你自己决定要不要看。
  base.thirdParty = base.sku.length >= 8;
  delete base.details;
  return base;
}

/* ------------------------------------------------------------------ */
export async function pingWeb(settings = {}) {
  const started = Date.now();
  const session = new WebSession(settings);
  try {
    const rows = await session.search({ categoryId: 'abcat0502000', limit: 5, maxPages: 1 });
    return {
      ok: rows.length > 0,
      ms: Date.now() - started,
      detail: rows.length
        ? `可用，示例：${rows[0].specs?.shortName || rows[0].name}（$${rows[0].price}）`
        : '页面打开了但没解析出商品，可能是 Best Buy 改版了',
    };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      detail: e instanceof BrowserError ? `浏览器问题：${e.message}` : e.message,
      code: e.code,
    };
  } finally {
    await session.close();
  }
}
