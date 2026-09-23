/**
 * Amazon 网页通道。
 *
 * 和其他 provider 同样的规矩：
 *  - 只读公开的搜索结果页，不登录、不下单、不碰账号
 *  - 请求之间强制间隔，不并发
 *  - 遇到人机验证/封禁页立刻停手并如实报错，绝不尝试绕过
 *
 * 和 B&H 的价格写法**正好相反**，别记混：
 *   B&H：  "$1,879.00 | $1,779 | 00"    → 原价完整在前，现价被拆成两段
 *   Amazon："$1,087.99 | $1,087 | . | 99 | List: $1,249.99"
 *                ↑完整现价先出现            ↑原价写作 List:
 * 所以这里取第一个完整 $x.xx 就是现价，不需要像 B&H 那样拼整数和小数。
 */
import os from 'node:os';
import path from 'node:path';
import { Browser, BrowserError } from '../browser/cdp.js';
import { extractSpecs } from '../specs.js';
import { log, money, num, sleep } from '../util.js';

const ORIGIN = 'https://www.amazon.com';
export const RETAILER = 'amazon';

/* Amazon 没有 B&H 那种干净的分类页，关键词搜索才是正路 */
const PART_TERMS = {
  laptop: 'laptop computer',
  desktop: 'desktop computer tower',
  gpu: 'graphics card',
  cpu: 'desktop cpu processor',
  ram: 'desktop memory ddr5',
  ssd: 'internal ssd nvme',
};

export class BlockedError extends Error {
  constructor(detail) {
    super(`Amazon 挡住了这次访问${detail ? `：${detail}` : ''}。已停止，不做绕过尝试。`);
    this.code = 'BLOCKED';
  }
}

export function buildListUrl({ part = 'gpu', keywords, page = 1 }) {
  const u = new URL('/s', ORIGIN);
  u.searchParams.set('k', String(keywords || PART_TERMS[part] || PART_TERMS.gpu).trim());
  if (page > 1) u.searchParams.set('page', String(page));
  return u.toString();
}

/**
 * 卡片提取。锚点用 data-asin —— 这是 Amazon 长期稳定的属性，
 * 比往上爬 DOM 找祖先节点可靠得多（其他两家没有等价物才那么写）。
 *
 * 会丢掉两类：
 *  - Sponsored 广告位（重复、且价格常和自然结果不一致）
 *  - 没有价格的卡（缺货、变体占位）
 */
const EXTRACT_LIST = String.raw`(() => {
  const toNum = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
  const out = [];
  const seen = new Set();

  for (const card of document.querySelectorAll('[data-asin]')) {
    const asin = card.getAttribute('data-asin');
    if (!asin || asin.length !== 10 || seen.has(asin)) continue;
    const text = (card.innerText || '').trim();
    if (!text || text.length > 3000) continue;
    if (/^sponsored/i.test(text)) continue;          // 广告位不要
    if (!/\$[\d,]+\.\d{2}/.test(text)) continue;     // 没价格的不要
    seen.add(asin);

    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);

    // 名称：跳过角标，取第一条足够长的行
    const BADGE = /^(sponsored|overall pick|best seller|amazon's choice|limited time deal|new arrival|climate pledge|more buying choices|\d[\d.]* out of 5|\(|\d+\+? bought|price, product page|save |join prime|or non-members|add to cart|list:?$)/i;
    const name = lines.find(l => l.length > 18 && !BADGE.test(l)) || ('ASIN ' + asin);

    // 现价：第一个完整的 $x.xx（Amazon 把完整价放在拆分版本之前）
    const priceM = text.match(/\$([\d,]+\.\d{2})/);
    let price = priceM ? toNum(priceM[1]) : null;

    // 原价：List: $x / Typical price: $x / Was: $x
    const listM = text.match(/(?:list|typical price|was)\s*:?\s*\$\s*([\d,]+\.\d{2})/i);
    let regular = listM ? toNum(listM[1]) : null;
    if (regular == null) {
      const saveM = text.match(/save\s*\$\s*([\d,]+\.\d{2})/i);
      if (saveM && price != null) regular = price + toNum(saveM[1]);
    }
    if (regular != null && price != null && regular <= price) regular = null;
    if (price == null) continue;

    const link = card.querySelector('a[href*="/dp/"]');
    const href = link ? link.getAttribute('href') : null;
    const img = card.querySelector('img');
    const rate = text.match(/([\d.]+)\s*out of 5/i);
    const revs = text.match(/\((\d[\d,]*)\)/);

    out.push({
      sku: asin,
      name,
      url: href ? new URL(href, location.origin).href : ('https://www.amazon.com/dp/' + asin),
      image: img ? (img.currentSrc || img.src || null) : null,
      price,
      regularPrice: regular,
      condition: /\brenewed\b|\brefurbish/i.test(text) ? 'Refurbished' : 'New',
      rating: rate ? Number(rate[1]) : null,
      reviews: revs ? Number(revs[1].replace(/,/g, '')) : null,
      inStock: !/currently unavailable|out of stock|temporarily out/i.test(text),
    });
  }
  return out;
})()`;

const COUNT_ITEMS = String.raw`(() => [...document.querySelectorAll('[data-asin]')]
  .filter(e => (e.getAttribute('data-asin') || '').length === 10).length)()`;

const PAGE_HEALTH = String.raw`(() => {
  const t = (document.body && document.body.innerText || '').slice(0, 2500);
  return {
    title: document.title,
    // Amazon 的拦截页文案很特征：'Enter the characters you see below' /
    // 'Sorry, we just need to make sure you're not a robot'
    blockedText: /enter the characters you see|not a robot|automated access|api-services-support@amazon/i.test(t),
    visibleCaptcha: !!document.querySelector('form[action*="validateCaptcha"]'),
    hasProducts: !!document.querySelector('[data-asin]'),
    noResults: /no results for|did not match any products/i.test(t),
  };
})()`;

export class AmazonSession {
  constructor(settings = {}) {
    this.settings = settings;
    this.browser = null;
    this.page = null;
    this.loads = 0;
    this.lastLoadAt = 0;
  }

  async open() {
    if (this.browser) return;
    // 熔断：这个 session 里浏览器已经起不来过一次，就别每条搜索都再拉一遍。
    // 踩过：浏览器起不来时 23 条搜索各试 2 次，20 秒里拉起约 46 个 Edge，把机器卡死。
    if (this.launchError) throw this.launchError;
    try {
      this.browser = await Browser.launch({
      exePath: this.settings.browserPath || undefined,
      // 每家零售商一个**固定**的 profile：cookie 能跨轮次保留，
      // 而且不用跟 Best Buy 抢共享 profile —— 以前 B&H/Amazon 每轮都只能拿一次性空目录，
      // 对网站来说每次都是陌生访客。
      profileDir: path.join(os.tmpdir(), 'bbt-browser-profile-amazon'),
      headless: this.settings.browserHeadless !== false,
      width: 1600,
      height: 1400,
    });
    } catch (e) {
      this.launchError = e;
      throw e;
    }
    this.page = await this.browser.newPage({ width: 1600, height: 1400 });
  }

  async close() {
    if (!this.browser) return;
    try { await this.page?.close(); } catch { /* ignore */ }
    try { await this.browser.close(); } catch { /* ignore */ }
    this.browser = null;
    this.page = null;
    log.info(`Amazon 浏览器已关闭（本轮加载了 ${this.loads} 个页面）`);
  }

  async #throttle() {
    const gap = Math.max(1200, this.settings.scrapeDelayMs || 2500);
    const wait = this.lastLoadAt + gap - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastLoadAt = Date.now();
  }

  async #load(url) {
    await this.open();
    await this.#throttle();
    this.loads++;
    await this.page.goto(url, { timeout: this.settings.requestTimeoutMs || 40000, settleMs: 3000 });
    const health = await this.page.evaluate(PAGE_HEALTH);
    const reallyBlocked = !health?.hasProducts && (health?.blockedText || health?.visibleCaptcha);
    if (reallyBlocked) {
      throw new BlockedError(health.visibleCaptcha ? '出现了验证码' : health.title || '挑战页');
    }
    return health;
  }

  async search({ part = 'gpu', keywords = '', limit = 40, maxPages = 3 }) {
    const cap = Math.min(num(limit) || 40, 200);
    const pages = Math.max(1, Math.min(Number(maxPages) || 3, 8));
    const all = new Map();

    for (let page = 1; page <= pages; page++) {
      const url = buildListUrl({ part, keywords, page });
      let rows = [];
      let onPage = null;
      try {
        const health = await this.#load(url);
        if (health?.noResults) break;
        // 页面既没有商品也没有"无结果"文案 —— 多半是没渲染完或换了布局。
        // 不吭声地返回 0 是最难查的故障（B&H 那边踩过），这里如实记一笔。
        if (!health?.hasProducts) {
          log.warn(`Amazon 第 ${page} 页没有data-asin 卡片，也没有"无结果"文案（标题：${health?.title || '?'}）——` +
            '当作空结果处理，但这通常意味着页面没渲染完或改版了');
        }
        onPage = await this.page.scrollToLoadAll({ maxRounds: 12, stepPause: 800, countExpr: COUNT_ITEMS });
        rows = (await this.page.evaluate(EXTRACT_LIST)) || [];
      } catch (e) {
        if (e.code === 'BLOCKED') throw e;
        log.warn(`Amazon 第 ${page} 页失败，跳过：${e.message}`);
        break;
      }
      if (!rows.length) break;

      let added = 0;
      for (const r of rows) {
        if (all.has(r.sku)) continue;
        all.set(r.sku, r);
        added++;
      }
      log.debug(`Amazon 第 ${page} 页：页面 ${onPage ?? '?'} 个卡片 → 提取 ${rows.length}，新增 ${added}（累计 ${all.size}）`);
      if (all.size >= cap || added === 0) break;
    }

    return [...all.values()].slice(0, cap).map(normalize);
  }
}

/* ------------------------------------------------------------------ */
function normalize(r) {
  const price = money(r.price);
  const regular = money(r.regularPrice);
  const pct =
    regular && price != null && regular > price
      ? Math.round(((regular - price) / regular) * 1000) / 10
      : null;

  const base = {
    sku: String(r.sku),
    name: r.name || `ASIN ${r.sku}`,
    image: r.image || null,
    url: r.url || `${ORIGIN}/dp/${r.sku}`,
    addToCartUrl: null,
    // Amazon 的名字是长逗号串，第一个词基本就是品牌
    manufacturer: (String(r.name || '').match(/^([A-Za-z][\w&.-]*)/) || [])[1] || null,
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
    source: 'amazon-web',
    retailer: RETAILER,
    // 搜索结果页看不出卖家是自营还是第三方，别假装知道。
    // 留 false 是为了不被"隐藏三方"误杀；真要区分得进商品页，而详情页不在本通道范围内。
    thirdParty: false,
    details: [],
  };
  base.specs = extractSpecs(base);
  delete base.details;
  return base;
}

export async function pingAmazon(settings = {}) {
  const started = Date.now();
  const session = new AmazonSession(settings);
  try {
    const rows = await session.search({ part: 'gpu', limit: 5, maxPages: 1 });
    return {
      ok: rows.length > 0,
      ms: Date.now() - started,
      detail: rows.length
        ? `可用，示例：${rows[0].specs?.shortName || rows[0].name}（$${rows[0].price}）`
        : '页面打开了但没解析出商品，可能是 Amazon 改版了',
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
