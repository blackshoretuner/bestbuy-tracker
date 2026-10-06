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

/* 锚点用的是语义稳定的东西：数字 SKU（卡片上的 data-product-id，或老式链接里的
   /sku/<数字>），以及卡片里的 "$xx.xx" 和 "The price was" 文案。不依赖混淆过的 class 名。

   2026-10 Best Buy 换了新版搜索页，踩了两个坑：
   1) 商品链接改成 /product/<slug>/<代码>（如 JJGGLHJXH7），**不再带 /sku/<数字>**。
      数字 SKU 挪到了卡片 <li data-product-id="6613959"> 上。只认 /sku/ 的话一台都抓不到
      （实测 "laptop rtx 5090" 页面写着 63 个结果，提取 0 台）。
   2) 商品网格是**虚拟列表**：只渲染视口附近的几行，滚走的会被卸掉。以前「先滚到底、
      再一次性提取」只能拿到最后几台 —— 日志里那些「页面 4 个商品链接」就是这么来的。
      现在每滚一步提取一次，攒在 window.__bbtRows 里，最后一起取走。
   两种布局都认，SKU 一律用数字的那个（榜单主键、关注列表认领都靠它）。 */
const EXTRACT_LIST = String.raw`(() => {
  const toNum = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
  const acc = (window.__bbtRows = window.__bbtRows || new Map());

  const found = [];
  // 新版布局：卡片自己带数字 SKU
  for (const li of document.querySelectorAll('[data-product-id]')) {
    const sku = String(li.getAttribute('data-product-id') || '');
    if (!/^\d{6,9}$/.test(sku)) continue;
    const a = li.querySelector('a[href*="/product/"], a[href*="/sku/"], a[href*="skuId="]');
    if (a) found.push({ sku, card: li, a });
  }
  // 老布局：SKU 在链接里，往上找最小的、包含价格的祖先节点当作商品卡
  for (const a of document.querySelectorAll('a[href*="/sku/"]')) {
    const m = (a.getAttribute('href') || '').match(/\/sku\/(\d{6,9})/);
    if (!m) continue;
    let card = null, node = a;
    for (let i = 0; i < 12 && node; i++, node = node.parentElement) {
      const t = node.innerText || '';
      if (/\$[\d,]+\.\d{2}/.test(t)) { card = node; if (t.length < 1400) break; }
    }
    if (card) found.push({ sku: m[1], card, a });
  }

  for (const { sku, card, a } of found) {
    if (acc.has(sku)) continue;
    const href = a.getAttribute('href') || '';
    const text = card.innerText || '';
    if (text.length > 3000) continue;              // 抓到整个网格了，不是单张卡
    if (!/\$[\d,]+\.\d{2}/.test(text)) continue;   // 价格还没渲染出来，下一步再看

    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    // Best Buy 商品名都是 "品牌 - 型号 - 规格 - 规格" 结构，取含 " - " 的最长行
    const named = lines.filter(l => l.includes(' - ')).sort((x, y) => y.length - x.length);
    const name = named[0] || a.getAttribute('aria-label') || lines[0] || ('SKU ' + sku);

    const prices = [...text.matchAll(/\$([\d,]+\.\d{2})/g)].map(x => toNum(x[1]));
    const wasM = text.match(/(?:the price was|price was|was|comp\. at)\s*\$?\s*([\d,]+\.\d{2})/i);
    // 新版写成 "Save $500"（不带分），老版 "Save $500.00"
    const saveM = text.match(/save\s*\$?\s*([\d,]+(?:\.\d{2})?)\b/i);

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
    const revs = text.match(/\((\d[\d,]*)(?:\s+reviews?)?\)/i);   // 老 "(15)"、新 "(15 reviews)"

    acc.set(sku, {
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
  // 见过的 SKU（不管有没有提取成功），和提取到的条数一对比，就知道有没有漏
  const seen = (window.__bbtSeen = window.__bbtSeen || new Set());
  for (const f of found) seen.add(f.sku);
  return [...acc.values()];
})()`;

/* 边滚边收：每一步都提取一次并攒起来，返回「见过的 SKU 数」给 scrollToLoadAll 判断还涨不涨 */
const RESET_COLLECT = `(() => { window.__bbtRows = new Map(); window.__bbtSeen = new Set(); return 0; })()`;
const COLLECT_COUNT = `(() => { ${EXTRACT_LIST}; return window.__bbtSeen.size; })()`;

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
    // 新版卡片没有 /sku/ 链接，SKU 在 data-product-id 上（见 EXTRACT_LIST）
    hasProducts: !!document.querySelector('a[href*="/sku/"], [data-product-id]'),
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

// 整个进程里，Best Buy 的页面**一次只开一个**，间隔照旧。
// 快速盯梢和 30 分钟一轮的全量查询会同时在跑、各开各的浏览器，但对 Best Buy 来说
// 仍然只是「一个访客、一页一页地看」—— 不并发的规矩不能因为多了一条通道就破掉。
// 锁按页加、不按整条搜索加：快速盯梢的页可以插进全量查询的两页之间，不用干等十分钟。
let pageChain = Promise.resolve();
let lastLoadAt = 0;
function onePageAtATime(fn) {
  const run = pageChain.then(fn);
  pageChain = run.catch(() => {});
  return run;
}

export class WebSession {
  /**
   * @param profileDir 不给就用默认的共享 profile。快速盯梢用自己固定的一个：
   *   不跟全量查询抢共享 profile（抢不到就得退到一次性目录，每次都是陌生访客），
   *   cookie 也能跨轮次留着。
   */
  constructor(settings = {}, { profileDir } = {}) {
    this.settings = settings;
    this.profileDir = profileDir;
    this.browser = null;
    this.page = null;
    this.loads = 0;
    this.pageErrors = 0;   // 吞掉的单页失败次数。快速盯梢靠它判断「这一轮到底看全了没有」
    this.relaunches = 0;
  }

  async open() {
    if (this.browser && !this.browser.closed) return;
    // 浏览器断了（电脑睡一觉醒来就是这样）：把死掉的那个收拾干净、重开一个，
    // 别让这一轮剩下的搜索全挂在「浏览器已关闭」上。一轮最多重开 2 次，免得反复断反复开
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
      if (++this.relaunches > 2) this.launchError = new BrowserError('浏览器反复断开，本轮不再重开', 'LAUNCH_FAILED');
      else log.warn('浏览器连接断了，重开一个');
    }
    // 熔断：这个 session 里浏览器已经起不来过一次，就别每条搜索都再拉一遍。
    // 踩过：浏览器起不来时 23 条搜索各试 2 次，20 秒里拉起约 46 个 Edge，把机器卡死。
    if (this.launchError) throw this.launchError;
    try {
      this.browser = await Browser.launch({
      exePath: this.settings.browserPath || undefined,
      profileDir: this.profileDir,
      headless: this.settings.browserHeadless !== false,
      width: 1600,
      height: 1200,
    });
    } catch (e) {
      this.launchError = e;
      throw e;
    }
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
    // 间隔按整个进程算（见 onePageAtATime），不是按这个 session 自己算
    const gap = Math.max(1200, this.settings.scrapeDelayMs || 2500);
    const wait = lastLoadAt + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastLoadAt = Date.now();
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
      let noResults = false;
      try {
        await this.open();   // 开浏览器要好几秒，别占着「一页一页」的锁开
        await onePageAtATime(async () => {
          const health = await this.#load(url, { settleMs: 1800 });
          if (health?.noResults) { noResults = true; return; }

          // 商品网格是虚拟列表，滚走的会被卸掉：先在顶上收一遍，再边滚边收（见 EXTRACT_LIST）。
          // onPage 是一路上见过的 SKU 数，用来和实际提取到的条数对比：
          // 两者差得多 = 提取逻辑漏了；两者都小 = 页面根本没给那么多。
          await this.page.evaluate(RESET_COLLECT);
          await this.page.evaluate(COLLECT_COUNT);
          onPage = await this.page.scrollToLoadAll({ maxRounds: 14, stepPause: 600, countExpr: COLLECT_COUNT });
          rows = (await this.page.evaluate(EXTRACT_LIST)) || [];
        });
      } catch (e) {
        if (e.code === 'BLOCKED') throw e;         // 被拦了就整条中止
        // 单页超时/出错不该拖垮整条搜索，用已经拿到的结果继续
        this.pageErrors++;
        log.warn(`搜索第 ${page} 页失败，跳过：${e.message}`);
        break;
      }
      if (noResults || !rows.length) break;

      let added = 0;
      for (const r of rows) {
        if (all.has(r.sku)) continue;
        all.set(r.sku, r);
        added++;
      }
      log.debug(
        `搜索页 ${page}：页面上见到 ${onPage ?? '?'} 个商品 → 提取 ${rows.length} 台，` +
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
    retailer: 'bestbuy',
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
