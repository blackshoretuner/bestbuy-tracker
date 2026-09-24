import { EventEmitter } from 'node:events';
import { store } from './store.js';
import {
  ApiKeyMissingError,
  getProductsBySkus,
  searchOpenBox,
  searchProducts,
} from './providers/bestbuyApi.js';
import { scrapeProduct } from './providers/scrape.js';
import { WebSession } from './providers/bestbuyWeb.js';
import { BhSession } from './providers/bhWeb.js';
import { AmazonSession } from './providers/amazonWeb.js';
import { isComponent, isComputer } from './specs.js';
import { matchAlert } from './alerts.js';
import { notifyDrops } from './notify.js';
import { pushDrops } from './phone.js';
import { createLimiter, inQuietHours, log, money, sleep } from './util.js';

/** 不走 Best Buy 通道的零售商 —— 各有自己的 provider 和 session */
const EXTERNAL_RETAILERS = new Set(['bh', 'amazon']);

const BOARD_TTL_MS = 45 * 86400000;

/** 这一轮要不要开浏览器 */
function usesWeb(settings) {
  if (settings.provider === 'web') return true;
  if (settings.provider === 'auto' && !settings.apiKey) return true;
  return false;
}

/** API 通道可用吗（auto 模式下有 Key 才算） */
function usesApi(settings) {
  return (settings.provider === 'api' || settings.provider === 'auto') && !!settings.apiKey;
}

export class Tracker extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.cycleInProgress = false;
    this.timer = null;
    this.nextRunAt = null;
    this.lastCycle = null;
    this.apiLimiter = createLimiter(250);
    this.scrapeLimiter = createLimiter(2500);
    this.#syncLimiters();
  }

  #syncLimiters() {
    const s = store.getSettings();
    this.apiLimiter.minInterval = Math.max(120, Math.floor(1000 / (s.requestsPerSecond || 4)));
    this.scrapeLimiter.minInterval = Math.max(1000, s.scrapeDelayMs || 2500);
  }

  /* ---------------------------------------------------------------- */
  /* 调度                                                              */
  /* ---------------------------------------------------------------- */
  start({ immediate } = {}) {
    const s = store.getSettings();
    if (this.running) {
      this.#schedule();
      return this.status();
    }
    this.running = true;
    log.info(`定时查询已启动，间隔 ${s.intervalMinutes} 分钟`);
    this.#emitStatus();
    if (immediate ?? s.runOnLaunch) {
      this.runCycle('启动').catch((e) => log.error('首轮查询失败', e.message));
    } else {
      this.#schedule();
    }
    return this.status();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    log.info('定时查询已停止');
    this.#emitStatus();
    return this.status();
  }

  restart() {
    const was = this.running;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.#syncLimiters();
    if (was) {
      this.#schedule();
      this.#emitStatus();
    }
    return this.status();
  }

  #schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (!this.running) return;
    const s = store.getSettings();
    const base = Math.max(1, s.intervalMinutes) * 60000;
    const jitter = base * ((s.jitterPercent || 0) / 100);
    const delay = Math.round(base + (Math.random() * 2 - 1) * jitter);
    this.nextRunAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.runCycle('定时').catch((e) => log.error('本轮查询失败', e.message));
    }, delay);
    this.#emitStatus();
  }

  status() {
    const s = store.getSettings();
    return {
      running: this.running,
      cycleInProgress: this.cycleInProgress,
      nextRunAt: this.nextRunAt,
      intervalMinutes: s.intervalMinutes,
      lastCycle: this.lastCycle,
      quietNow: inQuietHours(s.quietHours),
      hasApiKey: !!s.apiKey,
      provider: s.provider,
    };
  }

  #emitStatus() {
    this.emit('status', this.status());
  }

  /* ---------------------------------------------------------------- */
  /* 一轮完整查询                                                       */
  /* ---------------------------------------------------------------- */
  async runCycle(reason = '手动') {
    if (this.cycleInProgress) {
      log.warn('上一轮还没跑完，本次跳过');
      return this.lastCycle;
    }
    this.cycleInProgress = true;
    this.#syncLimiters();
    const started = Date.now();
    const settings = store.getSettings();
    const summary = {
      reason,
      startedAt: started,
      finishedAt: null,
      durationMs: 0,
      watchChecked: 0,
      watchFailed: 0,
      drops: 0,
      discovered: 0,
      searchesRun: 0,
      errors: [],
    };

    log.info(`开始第 ${reason} 轮查询…`);
    this.#emitStatus();

    const notifiable = [];
    // 整轮共用一个浏览器实例：开一次浏览器要好几秒，不值得每条搜索都开
    const session = usesWeb(settings) ? new WebSession(settings) : null;
    // 本轮自己的外部零售商 session 袋子，只有本轮会碰它
    const bag = Tracker.#newBag();

    try {
      const watchResult = await this.#refreshWatchlist(settings, notifiable, session);
      Object.assign(summary, watchResult);

      const searchResult = await this.#runSearches(settings, notifiable, session, bag);
      summary.discovered = searchResult.discovered;
      summary.searchesRun = searchResult.searchesRun;
      summary.errors.push(...searchResult.errors);
      summary.drops += searchResult.drops;

    } catch (e) {
      log.error('查询过程出错', e.message);
      summary.errors.push(e.friendly || e.message);
      store.addEvent({
        type: 'error',
        name: '查询失败',
        note: e.friendly || e.message,
      });
    } finally {
      if (session) await session.close().catch(() => {});
      await this.#closeBag(bag);
    }

    // 通知
    try {
      const quiet = inQuietHours(settings.quietHours);
      const filtered = settings.notify.onlyWatchlist
        ? notifiable.filter((d) => d.origin === 'watch')
        : notifiable;
      // 免打扰时段里，勾了"免打扰也弹"的特别关注仍然要通知 ——
      // 真在等的那台机器，半夜降价也得让你知道。其余的只写历史记录。
      const urgent = quiet
        ? filtered.filter((d) => d.alertHit?.ignoreQuietHours)
        : filtered;
      const muted = quiet ? filtered.length - urgent.length : 0;
      if (muted) log.info(`免打扰时段，${muted} 条降价只写入历史记录，不弹通知`);
      if (urgent.length) {
        if (quiet) log.info(`免打扰时段，但有 ${urgent.length} 条命中了「免打扰也提醒」的特别关注`);
        // 桌面通知和手机推送并行：手机那边网络慢或失败，不该拖住桌面通知，反之亦然
        await Promise.allSettled([notifyDrops(urgent, settings), pushDrops(urgent, settings)]);
      }
    } catch (e) {
      log.warn('通知发送异常', e.message);
    }

    // 维护
    try {
      store.pruneObservations(settings.keepObservationDays);
      store.prunePriceLog(settings.priceHistoryDays || 180);
      // 超过 45 天没再出现的机型从榜里清掉（多半已下架）
      store.pruneBoard(BOARD_TTL_MS);
      store.flushAll();
    } catch (e) {
      log.warn('数据清理异常', e.message);
    }

    summary.finishedAt = Date.now();
    summary.durationMs = summary.finishedAt - started;
    this.lastCycle = summary;
    this.cycleInProgress = false;

    log.info(
      `本轮结束：查了 ${summary.watchChecked} 个关注 / ${summary.searchesRun} 条搜索，` +
        `降价 ${summary.drops} 条，新发现 ${summary.discovered} 条，耗时 ${(summary.durationMs / 1000).toFixed(1)}s`
    );

    this.emit('cycle', summary);
    if (this.running) this.#schedule();
    else this.#emitStatus();

    return summary;
  }

  /* ---------------------------------------------------------------- */
  /* 关注列表刷新                                                       */
  /* ---------------------------------------------------------------- */
  async #refreshWatchlist(settings, notifiable, session) {
    const items = store.listWatch().filter((i) => i.enabled !== false);
    const out = { watchChecked: 0, watchFailed: 0, drops: 0, errors: [] };
    if (!items.length) return out;

    const useApi = usesApi(settings);
    const results = new Map();

    if (useApi) {
      // Open-Box 的条目 sku 会重复，用官方目录接口只查普通条目
      const plainSkus = items.filter((i) => !/open-box/i.test(i.condition || '')).map((i) => i.sku);
      if (plainSkus.length) {
        try {
          const map = await getProductsBySkus(plainSkus, settings.apiKey, this.apiLimiter);
          for (const [sku, p] of map) results.set(sku + '|plain', p);
        } catch (e) {
          const msg = e.friendly || e.message;
          log.error('批量取价失败', msg);
          out.errors.push(`关注列表取价：${msg}`);
        }
      }

      // Open-Box 条目逐个查
      for (const item of items.filter((i) => /open-box/i.test(i.condition || ''))) {
        try {
          const res = await searchOpenBox({ sku: item.sku, limit: 20 }, settings.apiKey, this.apiLimiter);
          const best = res.products
            .filter((p) => p.sku === item.sku)
            .sort((a, b) => a.price - b.price)[0];
          if (best) results.set(item.sku + '|openbox', best);
        } catch (e) {
          out.errors.push(`Open Box ${item.sku}：${e.friendly || e.message}`);
        }
      }
    } else if (settings.provider === 'api' && !settings.apiKey) {
      out.errors.push(new ApiKeyMissingError().message);
    }

    for (const item of items) {
      const isOpenBox = /open-box/i.test(item.condition || '');
      let fresh = results.get(item.sku + (isOpenBox ? '|openbox' : '|plain')) || null;

      // 浏览器通道：拿型号名去搜，再按 SKU 认领（详情页取不到，见 bestbuyWeb.js 注释）
      if (!fresh && session) {
        try {
          fresh = await session.findBySku(item.sku, { name: item.name, url: item.url });
          if (!fresh) {
            store.updateWatch(item.id, {
              lastError: '本轮没在搜索结果里找到它（价格保持上次的值）',
              lastCheckedAt: Date.now(),
            });
            out.watchFailed++;
            continue;
          }
        } catch (e) {
          store.updateWatch(item.id, { lastError: e.message, lastCheckedAt: Date.now() });
          out.watchFailed++;
          continue;
        }
      }

      // 老的裸 fetch 抓取，只在明确选了 scrape 时才用
      if (!fresh && settings.provider === 'scrape' && !isOpenBox) {
        try {
          fresh = await this.scrapeLimiter(() => scrapeProduct(item.sku, { timeout: settings.requestTimeoutMs }));
        } catch (e) {
          store.updateWatch(item.id, { lastError: e.message, lastCheckedAt: Date.now() });
          out.watchFailed++;
          continue;
        }
      }

      if (!fresh) {
        store.updateWatch(item.id, {
          lastError: usesApi(settings) ? '本轮没取到价格' : '没有可用的数据通道',
          lastCheckedAt: Date.now(),
        });
        out.watchFailed++;
        continue;
      }

      out.watchChecked++;
      const drop = this.#applyObservation(item, fresh, settings);
      if (drop) {
        out.drops++;
        notifiable.push({ ...drop, origin: 'watch' });
      }
    }

    store.flushWatch();
    return out;
  }

  /**
   * 记录一次采样，并判断是否构成"降价事件"。
   * 返回 drop 描述（用于通知），没降价返回 null。
   */
  #applyObservation(item, fresh, settings) {
    const now = Date.now();
    const price = money(fresh.price);
    const prev = item.current?.price ?? null;

    if (settings.recordEveryObservation) {
      store.addObservation({
        itemId: item.id,
        sku: item.sku,
        price,
        regularPrice: fresh.regularPrice,
        inStock: fresh.inStock,
      });
    }

    const patch = {
      lastCheckedAt: now,
      lastError: null,
      checks: (item.checks || 0) + 1,
      name: fresh.name || item.name,
      image: fresh.image || item.image,
      url: fresh.url || item.url,
      category: fresh.category || item.category,
      manufacturer: fresh.manufacturer || item.manufacturer,
      modelNumber: fresh.modelNumber || item.modelNumber,
      specs: fresh.specs || item.specs || null,
      current: {
        price,
        regularPrice: fresh.regularPrice,
        onSale: fresh.onSale,
        percentOff: fresh.percentOff,
        inStock: fresh.inStock,
        ts: now,
      },
    };

    if (!item.first) patch.first = { price, ts: now };
    if (price !== null) {
      if (!item.low || price < item.low.price) patch.low = { price, ts: now };
      if (!item.high || price > item.high.price) patch.high = { price, ts: now };
    }

    const evBase = {
      itemId: item.id,
      sku: item.sku,
      name: patch.name,
      url: patch.url,
      image: patch.image,
      condition: item.condition,
      specs: patch.specs,
      category: patch.category,
    };

    let drop = null;

    if (prev === null && price !== null) {
      // 首次取到价，只建立基线，不算降价
      store.addEvent({
        ...evBase,
        type: 'baseline',
        price,
        regularPrice: fresh.regularPrice,
        note: '开始跟踪',
      });
    } else if (price !== null && prev !== null && price < prev) {
      const delta = money(prev - price);
      const pct = Math.round(((prev - price) / prev) * 1000) / 10;
      const passes =
        pct >= (settings.dropMinPercent || 0) && delta >= (settings.dropMinAmount || 0);

      if (passes) {
        const isLow = !item.low || price <= item.low.price;
        const hitsTarget = item.targetPrice != null && price <= item.targetPrice;
        const ev = store.addEvent({
          ...evBase,
          type: hitsTarget ? 'target' : 'drop',
          price,
          prevPrice: prev,
          delta,
          pct,
          regularPrice: fresh.regularPrice,
          isAllTimeLow: isLow,
          targetPrice: item.targetPrice ?? null,
          note: hitsTarget ? `已跌破目标价 $${item.targetPrice}` : isLow ? '历史新低' : '',
        });
        patch.drops = (item.drops || 0) + 1;
        drop = ev;
        log.info(`降价：${patch.name} $${prev} → $${price} (-${pct}%)`);
      }
    } else if (price !== null && prev !== null && price > prev) {
      const pct = Math.round(((price - prev) / prev) * 1000) / 10;
      store.addEvent({
        ...evBase,
        type: 'rise',
        price,
        prevPrice: prev,
        delta: money(price - prev),
        pct,
        regularPrice: fresh.regularPrice,
        note: '涨价',
      });
    }

    // 补货
    if (item.current && item.current.inStock === false && fresh.inStock === true) {
      store.addEvent({
        ...evBase,
        type: 'restock',
        price,
        regularPrice: fresh.regularPrice,
        note: '重新有货',
      });
    }

    store.updateWatch(item.id, patch);
    return drop;
  }

  /* ---------------------------------------------------------------- */
  /* 自动搜索：把数码区符合条件的降价直接写进历史记录                      */
  /* ---------------------------------------------------------------- */
  /**
   * 非 Best Buy 的零售商各有自己的 provider，session 按需开、整轮共用
   *（开一次浏览器要好几秒，不值得每条搜索都开）。轮次结束统一收摊。
   */
  /**
   * 外部零售商（B&H / Amazon）的 session 装在一个「袋子」里，**跟着调用方走**，
   * 不挂在 this 上。
   *
   * 为什么不用共享槽位：踩过一次 —— 定时轮次和界面上「立即运行」会同时进行，
   * 两边共用 this._bh / this._amz 的话，轮次结束时的收摊会把手动那次
   * 正在用的浏览器关掉，日志里就是 "Amazon 第 1 页失败：浏览器已关闭"。
   * 袋子由谁创建谁负责关，天然不会互相踩。
   */
  static #newBag() {
    return new Map();
  }

  async #bagSession(bag, retailer, settings) {
    if (!bag.has(retailer)) {
      bag.set(retailer, retailer === 'amazon' ? new AmazonSession(settings) : new BhSession(settings));
    }
    return bag.get(retailer);
  }

  async #closeBag(bag) {
    if (!bag) return;
    for (const sess of bag.values()) await sess.close().catch(() => {});
    bag.clear();
  }

  async #runSearches(settings, notifiable, session, bag) {
    const out = { discovered: 0, searchesRun: 0, drops: 0, errors: [] };
    const searches = store.listSearches().filter((s) => s.enabled !== false);
    if (!searches.length) return out;

    // B&H 的搜索不依赖 Best Buy 的通道，别被下面那个"没有可用通道"挡住
    const onlyExternal = searches.every((s) => EXTERNAL_RETAILERS.has(s.retailer));
    if (onlyExternal) return this.#runSearchList(searches, settings, notifiable, session, out, bag);

    if (!session && !usesApi(settings)) {
      out.errors.push('没有可用的数据通道：去「设置」把通道选成「浏览器」，或者填入 API Key');
      return out;
    }

    return this.#runSearchList(searches, settings, notifiable, session, out, bag);
  }

  /** 跑一批搜索。抽出来是为了让"全是 B&H"的情况能跳过 Best Buy 的通道检查。 */
  async #runSearchList(searches, settings, notifiable, session, out, bag) {
    // 本轮已经把我们挡在门外的零售商。被挡一次就停手，本轮不再去撞同一家 ——
    // 实测 B&H 弹「请稍候…」后，剩下 5 条 B&H 搜索还是逐条去撞同一个拦截页，
    // 对正在拦截的网站连续发请求既不礼貌也白耗时间。下一轮再试。
    const blocked = new Set();

    for (const [i, search] of searches.entries()) {
      const shop = search.retailer || 'bestbuy';
      if (blocked.has(shop)) {
        store.updateSearch(search.id, {
          lastError: '本轮这家零售商已拦截访问，跳过（下一轮再试）',
          lastRunAt: Date.now(),
        });
        continue;
      }
      try {
        const res = await this.runSearchOnce(search, settings, { record: true, notifiable, session, bag });
        out.searchesRun++;
        out.discovered += res.newCount;
        out.drops += res.dropCount;
      } catch (e) {
        const msg = e.friendly || e.message;
        store.updateSearch(search.id, { lastError: msg, lastRunAt: Date.now() });
        out.errors.push(`搜索「${search.name}」：${msg}`);
        log.error(`搜索「${search.name}」失败`, msg);
        if (e.code === 'BLOCKED') {
          blocked.add(shop);
          const rest = searches.slice(i + 1).filter((s) => (s.retailer || 'bestbuy') === shop).length;
          if (rest) log.warn(`${shop} 拦截了访问，本轮跳过它剩下的 ${rest} 条搜索`);
        }
      }
      await sleep(150);
    }
    store.flushSearches();
    return out;
  }

  async runSearchOnce(
    search,
    settings = store.getSettings(),
    { record = true, notifiable = [], session = null, bag = null } = {}
  ) {
    const limit = Math.min(search.limit || 40, settings.maxDiscoverPerSearch || 60);
    let products = [];
    let meta = {};

    // 没传 session 但需要浏览器（比如从界面上点"立即运行"），临时开一个
    // B&H 的搜索用不着 Best Buy 的 session，别白开一个浏览器
    let ownSession = null;
    if (!session && usesWeb(settings) && !EXTERNAL_RETAILERS.has(search.retailer)) {
      ownSession = new WebSession(settings);
      session = ownSession;
    }

    // 调用方没给袋子（界面上点「立即运行」）就自己开一个，用完自己关。
    // 绝不碰别人的袋子 —— 定时轮次可能正在用。
    const ownBag = bag ? null : Tracker.#newBag();

    try {
      ({ products, meta } = await this.#fetchForSearch(search, settings, limit, session, bag || ownBag));
    } finally {
      if (ownSession) await ownSession.close().catch(() => {});
      await this.#closeBag(ownBag);
    }

    return this.#recordSearchResults(search, settings, products, meta, { record, notifiable });
  }

  async #fetchForSearch(search, settings, limit, session, bag) {
    let products = [];
    let meta = {};

    // B&H 走自己的 provider：URL、卡片结构、价格写法和 Best Buy 完全不同
    //（B&H 把现价的整数和小数拆成两个元素，详见 bhWeb.js 的注释）。
    // 每个零售商一个 session，整轮共用，不为每条搜索反复开浏览器。
    if (EXTERNAL_RETAILERS.has(search.retailer)) {
      const sess = await this.#bagSession(bag, search.retailer, settings);
      products = await sess.search({
        part: search.part || 'gpu',
        keywords: search.keywords || '',
        limit,
        maxPages: settings.maxPagesPerSearch || 3,
      });
      meta = { channel: `${search.retailer}-web`, retailer: search.retailer, fetched: products.length };
      const min = search.minPrice;
      const max = search.maxPrice;
      if (min != null) products = products.filter((p) => p.price >= min);
      if (max != null) products = products.filter((p) => p.price <= max);
      if (search.minPercentOff) products = products.filter((p) => (p.percentOff ?? 0) >= search.minPercentOff);
      meta.afterFilter = products.length;
      return { products, meta };
    }

    // 浏览器通道优先（provider=web 时 session 一定存在）
    if (session) {
      products = await session.search({
        categoryId: search.categoryId,
        keywords: search.keywords,
        condition: search.channel === 'openbox' ? 'openbox' : search.condition,
        limit,
        maxPages: settings.maxPagesPerSearch || 3,
      });
      meta = { channel: 'web', fetched: products.length };

      // 网页通道没有服务端筛选，价格/折扣/品相在本地过滤
      const min = search.minPrice;
      const max = search.maxPrice;
      const pct = search.minPercentOff || 0;
      if (min != null) products = products.filter((p) => p.price >= min);
      if (max != null) products = products.filter((p) => p.price <= max);
      if (pct) products = products.filter((p) => (p.percentOff ?? 0) >= pct);
      if (search.onSaleOnly) products = products.filter((p) => p.onSale);
      // 「隐藏三方」只管整机。散装配件在 Best Buy 上几乎全是 Marketplace ——
      // 实测内存 24/24 = 100%、CPU 22/24 = 92% 是三方，一刀切会把硬件板块清空
      //（实测内存 40 件 → 0 件）。硬件照常收录，界面仍会标「三方」徽标，
      // 退换货政策的取舍留给用户自己看。
      if (settings.hideThirdParty && search.kind !== 'hardware') {
        products = products.filter((p) => !p.thirdParty);
      }
      if (search.condition === 'refurbished') products = products.filter((p) => /refurb/i.test(p.condition));
      if (search.condition === 'preowned') products = products.filter((p) => /pre-?owned/i.test(p.condition));
      if (search.channel === 'openbox') products = products.filter((p) => /open-?box/i.test(p.condition));
      meta.afterFilter = products.length;
      return { products, meta };
    }

    if (search.channel === 'openbox') {
      const res = await searchOpenBox(
        {
          categoryId: search.categoryId,
          keywords: search.keywords,
          minPrice: search.minPrice,
          maxPrice: search.maxPrice,
          minPercentOff: search.minPercentOff,
          limit,
        },
        settings.apiKey,
        this.apiLimiter
      );
      if (!res.available) {
        throw Object.assign(new Error(`Open Box 接口不可用：${res.reason}`), { code: 'OPENBOX_UNAVAILABLE' });
      }
      products = res.products;
      meta = { endpoint: res.endpoint };
    } else {
      const res = await searchProducts({ ...search, limit }, settings.apiKey, this.apiLimiter);
      products = res.products;
      meta = { droppedFilters: res.droppedFilters, appliedClientSide: res.appliedClientSide, total: res.total };
    }

    return { products, meta };
  }

  #recordSearchResults(search, settings, products, meta, { record, notifiable }) {
    // 只留电脑：把配件、扩展坞、包、鼠标之类滤掉
    // 按这条搜索找的是什么来过滤。以前是无条件只留整机，硬件搜索会被整个滤掉
    //（实测显卡 20/20 全灭）。设置项名字还叫 onlyComputers 是为了不动已存的配置，
    // 含义扩展成"只保留这条搜索的目标品类"。
    if (settings.onlyComputers) {
      const before = products.length;
      const keep = search.kind === 'hardware' ? isComponent : isComputer;
      products = products.filter((p) => keep(p.specs || {}));
      meta.filteredOut = before - products.length;
    }

    let newCount = 0;
    let dropCount = 0;

    if (record) {
      for (const p of products) {
        const price = money(p.price);
        if (price === null) continue;

        const { isNew, dropped, prevPrice, row } = store.upsertBoard({ ...p, price }, search.id);
        // 价格轨迹：只在变价时落一个点，历史分位靠它算
        store.recordPrice(row.key, price);

        const evBase = {
          searchId: search.id,
          searchName: search.name,
          boardKey: row.key,
          sku: p.sku,
          name: p.name,
          url: p.url,
          image: p.image,
          condition: p.condition,
          category: p.category,
          specs: p.specs || null,
          price,
          regularPrice: p.regularPrice,
        };

        if (isNew) {
          newCount++;
          store.addEvent({
            ...evBase,
            type: 'found',
            pct: p.percentOff,
            delta: p.dollarSavings,
            note: p.percentOff ? `新发现，比原价低 ${p.percentOff}%` : '新发现',
          });
        } else if (dropped) {
          const delta = money(prevPrice - price);
          const pct = Math.round(((prevPrice - price) / prevPrice) * 1000) / 10;
          // 特别关注命中时**绕开全局阈值** —— 全局是"降这么多才值得打扰我"，
          // 特别关注是"这台我盯着，标准另算"，被全局先吞掉就失去意义了。
          const hit = matchAlert({ ...p, price, retailer: p.retailer }, { pct, delta }, settings.alerts);
          const passes =
            !!hit || (pct >= (settings.dropMinPercent || 0) && delta >= (settings.dropMinAmount || 0));
          if (passes) {
            dropCount++;
            // upsertBoard 已经把 minPrice 更新成新价了，得跟"上一个低点"比
            const isLow = row.seenCount >= 3 && row.prevMinPrice != null && price < row.prevMinPrice;
            const ev = store.addEvent({
              ...evBase,
              type: 'drop',
              prevPrice,
              delta,
              pct,
              isAllTimeLow: isLow,
              alert: hit ? { keyword: hit.keyword, note: hit.note || '' } : null,
              note: hit
                ? `⚡ 特别关注「${hit.keyword}」${isLow ? ' · 跟踪以来最低' : ''}`
                : isLow ? `跟踪以来最低 · 来自「${search.name}」` : `来自「${search.name}」`,
            });
            notifiable.push({ ...ev, origin: 'search', alertHit: hit || null });
          }
        }
      }
    }

    store.updateSearch(search.id, {
      lastRunAt: Date.now(),
      lastCount: products.length,
      lastError: null,
      lastMeta: meta,
    });

    return { products, newCount, dropCount, meta };
  }
}

export const tracker = new Tracker();
