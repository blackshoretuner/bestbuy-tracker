/**
 * B&H（bhphotovideo.com）网页通道。
 *
 * 和 bestbuyWeb.js 同样的规矩：
 *  - 只读公开的商品列表页，不登录、不下单、不碰账号
 *  - 请求之间强制间隔，不并发
 *  - 遇到人机验证/封禁页立刻停手并如实报错，绝不尝试绕过
 *
 * 为什么单独一个文件而不是复用 bestbuyWeb：两家的 URL、卡片结构、价格写法
 * 完全不同（尤其是价格，见 EXTRACT_LIST 的注释），硬凑一套只会互相绊脚。
 */
import os from 'node:os';
import path from 'node:path';
import { Browser, BrowserError } from '../browser/cdp.js';
import { extractSpecs } from '../specs.js';
import { log, money, num, sleep } from '../util.js';

const ORIGIN = 'https://www.bhphotovideo.com';
export const RETAILER = 'bh';

/* 我们的品类 → B&H 分类页。分类页比搜索页出货稳，也不用猜关键词。 */
const CATEGORY_PATHS = {
  // 整机。实测 ci/6550 是唯一稳定出货的笔电分类页；关键词搜索（/c/search）
  // 走我们的提取器返回 0 件，别用。
  laptop: '/c/buy/Laptops/ci/6550',
  desktop: '/c/buy/Desktop-Computers/ci/6549',
  gpu: '/c/buy/Graphic-Cards/ci/6567',
  cpu: '/c/buy/CPUs-Processors/ci/6568',
  ram: '/c/buy/Memory-RAM/ci/6569',
  ssd: '/c/buy/Internal-Solid-State-Drives/ci/15570',
};

export class BlockedError extends Error {
  constructor(detail) {
    super(`B&H 挡住了这次访问${detail ? `：${detail}` : ''}。已停止，不做绕过尝试。`);
    this.code = 'BLOCKED';
  }
}

export function buildListUrl({ part = 'gpu', keywords, page = 1 }) {
  const u = keywords
    ? new URL('/c/search', ORIGIN)
    : new URL(CATEGORY_PATHS[part] || CATEGORY_PATHS.gpu, ORIGIN);
  if (keywords) u.searchParams.set('q', String(keywords).trim());
  if (page > 1) u.searchParams.set('pn', String(page));
  return u.toString();
}

/**
 * 卡片提取。锚点是语义稳定的东西：商品链接里的 /c/product/<数字>、
 * 卡片文本里的 "BH #" 和价格；不依赖混淆过的 class 名。
 *
 * 价格是这里最容易写错的地方。B&H 把**现价的整数和小数拆成两个元素**：
 *   "$1,879.00 | $1,779 | 00 | Save $100.00"
 *      ↑原价(完整)  ↑现价整数 ↑分   ↑省多少
 * 所以「取第一个 $x.xx」会把原价当成现价。规则：
 *   先找 "$1,234" 且下一行是两位数字 → 那才是现价；
 *   在它之前出现的完整 $x.xx 是原价；
 *   最后用 "Save $x" 交叉校验。
 */
const EXTRACT_LIST = String.raw`(() => {
  const toNum = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
  const out = [];
  const seen = new Set();

  for (const a of document.querySelectorAll('a[href*="/c/product/"]')) {
    const m = (a.getAttribute('href') || '').match(/\/c\/product\/(\d{6,})/);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;

    let card = null, node = a;
    for (let i = 0; i < 14 && node; i++, node = node.parentElement) {
      const t = node.innerText || '';
      if (/\$[\d,]+/.test(t) && /BH\s*#/.test(t)) { card = node; if (t.length < 1400) break; }
    }
    if (!card) continue;
    const text = card.innerText || '';
    if (text.length > 3000) continue;
    seen.add(id);

    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);

    const bhIdx = lines.findIndex(l => /^BH\s*#/i.test(l));
    const nameCandidates = lines
      .slice(0, bhIdx < 0 ? 4 : bhIdx)
      .filter(l => !/^(compare|top seller|new item|sponsored|in stock|save)\b/i.test(l) && l.length > 6);
    const name = nameCandidates.sort((x, y) => y.length - x.length)[0] || ('BH ' + id);

    let price = null, regular = null;
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\$[\d,]+$/.test(lines[i]) && /^\d{2}$/.test(lines[i + 1])) {
        price = toNum(lines[i]) + Number(lines[i + 1]) / 100;
        for (let j = 0; j < i; j++) {
          const w = lines[j].match(/^\$([\d,]+\.\d{2})$/);
          if (w) regular = toNum(w[1]);
        }
        break;
      }
    }
    if (price == null) {
      const all = [...text.matchAll(/\$([\d,]+\.\d{2})/g)].map(x => toNum(x[1]));
      if (all.length) price = all[0];
    }
    const save = text.match(/save\s*\$\s*([\d,]+\.\d{2})/i);
    if (save && price != null) {
      const implied = price + toNum(save[1]);
      if (regular == null || Math.abs(regular - implied) > 1) regular = implied;
    }
    if (regular != null && price != null && regular <= price) regular = null;
    if (price == null) continue;

    const bh = (lines[bhIdx] || '').match(/^BH\s*#\s*(\S+)/i);
    const mfr = text.match(/MFR\s*#\s*(\S+)/i);
    const img = card.querySelector('img');
    const rate = text.match(/([\d.]+)\s*out of 5/i);
    const revs = text.match(/(\d[\d,]*)\s+Reviews?/i);

    out.push({
      sku: id,
      name,
      url: new URL(a.getAttribute('href'), location.origin).href,
      image: img ? (img.currentSrc || img.src || null) : null,
      price,
      regularPrice: regular,
      condition: /\brefurbish/i.test(text) ? 'Refurbished' : 'New',
      itemNumber: bh ? bh[1] : null,
      modelNumber: mfr ? mfr[1] : null,
      rating: rate ? Number(rate[1]) : null,
      reviews: revs ? Number(revs[1].replace(/,/g, '')) : null,
      inStock: !/sold out|out of stock|discontinued|back-?ordered/i.test(text),
    });
  }
  return out;
})()`;

const COUNT_ITEMS = String.raw`(() => new Set([...document.querySelectorAll('a[href*="/c/product/"]')]
  .map(a => (a.getAttribute('href').match(/\/c\/product\/(\d{6,})/) || [])[1]).filter(Boolean)).size)()`;

const PAGE_HEALTH = String.raw`(() => {
  const t = (document.body && document.body.innerText || '').slice(0, 2500);
  const bigCaptcha = [...document.querySelectorAll('iframe[src*="captcha"], #px-captcha, [id*="challenge"]')]
    .some(f => { const r = f.getBoundingClientRect(); return r.width > 120 && r.height > 80; });
  return {
    title: document.title,
    blockedText: /access denied|are you a robot|unusual traffic|verify you are human|just a moment|请稍候|安全验证/i.test(t),
    visibleCaptcha: bigCaptcha,
    hasProducts: !!document.querySelector('a[href*="/c/product/"]'),
    noResults: /no results|did not match|0 items found/i.test(t),
  };
})()`;

export class BhSession {
  constructor(settings = {}) {
    this.settings = settings;
    this.browser = null;
    this.page = null;
    this.loads = 0;
    this.lastLoadAt = 0;
    this.relaunches = 0;
  }

  async open() {
    if (this.browser && !this.browser.closed) return;
    // 浏览器断了（电脑睡一觉醒来就是这样）：收拾干净、重开一个，一轮最多 2 次（同 bestbuyWeb.js）
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
      if (++this.relaunches > 2) this.launchError = new BrowserError('浏览器反复断开，本轮不再重开', 'LAUNCH_FAILED');
      else log.warn('B&H 浏览器连接断了，重开一个');
    }
    // 熔断：这个 session 里浏览器已经起不来过一次，就别每条搜索都再拉一遍。
    // 踩过：浏览器起不来时 23 条搜索各试 2 次，20 秒里拉起约 46 个 Edge，把机器卡死。
    if (this.launchError) throw this.launchError;
    try {
      this.browser = await Browser.launch({
      exePath: this.settings.browserPath || undefined,
      // 每家零售商一个**固定**的 profile：cookie 能跨轮次保留，
      // 而且不用跟 Best Buy 抢共享 profile —— 以前 B&H/Amazon 每轮都只能拿一次性空目录，
      // 对网站来说每次都是陌生访客。
      profileDir: path.join(os.tmpdir(), 'bbt-browser-profile-bh'),
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
    log.info(`B&H 浏览器已关闭（本轮加载了 ${this.loads} 个页面）`);
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
    await this.page.goto(url, { timeout: this.settings.requestTimeoutMs || 40000, settleMs: 2500 });
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
          log.warn(`B&H 第 ${page} 页没有/c/product/ 链接，也没有"无结果"文案（标题：${health?.title || '?'}）——` +
            '当作空结果处理，但这通常意味着页面没渲染完或改版了');
        }
        // B&H 的价格是延迟渲染的：实测滚动前只有 3 个价格串，滚过 8 屏后 42 个
        onPage = await this.page.scrollToLoadAll({ maxRounds: 14, stepPause: 900, countExpr: COUNT_ITEMS });
        rows = (await this.page.evaluate(EXTRACT_LIST)) || [];
      } catch (e) {
        if (e.code === 'BLOCKED') throw e;
        log.warn(`B&H 第 ${page} 页失败，跳过：${e.message}`);
        break;
      }
      if (!rows.length) break;

      let added = 0;
      for (const r of rows) {
        if (all.has(r.sku)) continue;
        all.set(r.sku, r);
        added++;
      }
      log.debug(`B&H 第 ${page} 页：页面 ${onPage ?? '?'} 个商品 → 提取 ${rows.length}，新增 ${added}（累计 ${all.size}）`);
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
    name: r.name || `BH ${r.sku}`,
    image: r.image || null,
    url: r.url || `${ORIGIN}/c/product/${r.sku}`,
    addToCartUrl: null,
    // B&H 的名字不是 "品牌 - 型号 - 规格" 结构，第一个词基本就是品牌
    manufacturer: (String(r.name || '').match(/^([A-Za-z][\w&.-]*)/) || [])[1] || null,
    modelNumber: r.modelNumber || null,
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
    source: 'bh-web',
    retailer: RETAILER,
    // B&H 自营，没有 Marketplace 第三方卖家那一套
    thirdParty: false,
    details: [],
  };
  base.specs = extractSpecs(base);
  delete base.details;
  return base;
}

export async function pingBh(settings = {}) {
  const started = Date.now();
  const session = new BhSession(settings);
  try {
    const rows = await session.search({ part: 'gpu', limit: 5, maxPages: 1 });
    return {
      ok: rows.length > 0,
      ms: Date.now() - started,
      detail: rows.length
        ? `可用，示例：${rows[0].specs?.shortName || rows[0].name}（$${rows[0].price}）`
        : '页面打开了但没解析出商品，可能是 B&H 改版了',
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
