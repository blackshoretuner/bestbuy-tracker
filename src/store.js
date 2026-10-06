import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DEFAULT_SETTINGS, seedSearches } from './config.js';
import { log, uid } from './util.js';

/* ------------------------------------------------------------------ */
/* 原子写入的 JSON 文件                                                 */
/* ------------------------------------------------------------------ */
class JsonFile {
  constructor(name, fallback) {
    this.file = path.join(DATA_DIR, name);
    this.fallback = fallback;
    this.data = this.#load();
    this.timer = null;
  }

  #load() {
    try {
      if (!fs.existsSync(this.file)) return structuredClone(this.fallback);
      const raw = fs.readFileSync(this.file, 'utf8');
      if (!raw.trim()) return structuredClone(this.fallback);
      return JSON.parse(raw);
    } catch (e) {
      log.error(`读取 ${path.basename(this.file)} 失败，已回退到默认值`, e.message);
      try {
        fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now());
      } catch { /* ignore */ }
      return structuredClone(this.fallback);
    }
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 300);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      log.error(`写入 ${path.basename(this.file)} 失败`, e.message);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 追加式日志文件 (JSONL)：价格采样点 & 事件                             */
/* ------------------------------------------------------------------ */
class JsonlFile {
  constructor(name, cap) {
    this.file = path.join(DATA_DIR, name);
    this.cap = cap;
    this.rows = this.#load();
  }

  #load() {
    try {
      if (!fs.existsSync(this.file)) return [];
      const raw = fs.readFileSync(this.file, 'utf8');
      const lines = raw.split('\n');
      const rows = [];
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try { rows.push(JSON.parse(t)); } catch { /* 跳过坏行 */ }
      }
      if (rows.length > this.cap) {
        const kept = rows.slice(-this.cap);
        this.#rewrite(kept);
        return kept;
      }
      return rows;
    } catch (e) {
      log.error(`读取 ${path.basename(this.file)} 失败`, e.message);
      return [];
    }
  }

  #rewrite(rows) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, this.file);
  }

  append(row) {
    this.rows.push(row);
    try {
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n', 'utf8');
    } catch (e) {
      log.error(`追加 ${path.basename(this.file)} 失败`, e.message);
    }
    if (this.rows.length > this.cap * 1.2) {
      this.rows = this.rows.slice(-this.cap);
      try { this.#rewrite(this.rows); } catch { /* ignore */ }
    }
    return row;
  }

  prune(predicate) {
    const before = this.rows.length;
    this.rows = this.rows.filter(predicate);
    if (this.rows.length !== before) {
      try { this.#rewrite(this.rows); } catch { /* ignore */ }
    }
    return before - this.rows.length;
  }

  clear() {
    this.rows = [];
    try { fs.writeFileSync(this.file, '', 'utf8'); } catch { /* ignore */ }
  }

  /** 整体替换（迁移用：批量改键之后一次落盘，别 clear 再逐条 append） */
  replaceAll(rows) {
    this.rows = rows;
    try { this.#rewrite(rows); } catch (e) {
      log.error(`重写 ${path.basename(this.file)} 失败`, e.message);
    }
    return rows.length;
  }
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */
const settingsFile = new JsonFile('settings.json', DEFAULT_SETTINGS);
const watchFile = new JsonFile('watchlist.json', { items: [] });
const searchFile = new JsonFile('searches.json', { items: null });
const boardFile = new JsonFile('board.json', { rows: {} });

export const observations = new JsonlFile('observations.jsonl', 80000);
export const events = new JsonlFile('events.jsonl', 20000);

/**
 * 榜上每台机器的价格轨迹。字段名压到一个字母（k/t/p）是因为这文件会长得最快。
 *
 * 关键：**只在价格变化时追加**。价格不动的时候每半小时记一条纯属浪费——
 * 120 台 × 48 次/天 = 每天 5760 条，跑仨月就 50 万条。只记变化的话，
 * 一台机器一年也就几十条。分位计算按时间加权，本来也只需要这些拐点。
 */
const priceLog = new JsonlFile('pricelog.jsonl', 200000);

/** key -> [{t, p}]，开机时建一次，之后增量维护 */
const priceIndex = new Map();
for (const r of priceLog.rows) {
  if (!r?.k) continue;
  let arr = priceIndex.get(r.k);
  if (!arr) priceIndex.set(r.k, (arr = []));
  arr.push({ t: r.t, p: r.p });
}
for (const arr of priceIndex.values()) arr.sort((a, b) => a.t - b.t);

// 首次运行：塞入几条默认的数码区自动搜索
if (!searchFile.data.items) {
  searchFile.data.items = seedSearches();
  searchFile.flush();
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 历史记录的排序方式。
 *
 * 「新发现」这类事件没有 pct/delta，按跌幅排时一律沉底（用 -1 兜底），
 * 别让一堆没有跌幅的记录混在真降价前面 —— 和电脑榜"没数据的排最后"一个道理。
 * 所有比较器返回 0 时，调用方还会再按时间倒序兜一层，保证顺序稳定不乱跳。
 */
const heldMs = (e) => (e.prevTs ? e.ts - e.prevTs : -1);

/**
 * 「跌幅」只对**我们真观测到的降价**才成立。
 *
 * 坑在这里：found 事件也带 pct/delta，但那是 Best Buy 自己标的
 * regularPrice 折扣（tracker.js 里 `pct: p.percentOff`），和 drop 事件的
 * "上一轮 → 这一轮真的跌了多少"完全是两回事。同一个字段名，两种含义。
 * 不把它们分开的话，按「跌幅 ↓」排序会让一堆标称折扣冒充真降价占满榜首 ——
 * 正是 regularPrice 常年虚高要防的事。
 */
const OBSERVED_DROP = new Set(['drop', 'target']);
const dropPct = (e) => (OBSERVED_DROP.has(e.type) && e.pct != null ? e.pct : -1);
const dropDelta = (e) => (OBSERVED_DROP.has(e.type) && e.delta != null ? e.delta : -1);

const EVENT_SORTS = {
  recent: (a, b) => b.ts - a.ts,
  oldest: (a, b) => a.ts - b.ts,
  pct: (a, b) => dropPct(b) - dropPct(a),
  delta: (a, b) => dropDelta(b) - dropDelta(a),
  price: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
  '-price': (a, b) => (b.price ?? -1) - (a.price ?? -1),
  // 这个价挂了多久才降 —— 挂得越久的降价越有"憋出来的"意味
  held: (a, b) => heldMs(b) - heldMs(a),
  name: (a, b) =>
    String(a.specs?.shortName || a.name || '').localeCompare(String(b.specs?.shortName || b.name || '')),
};

export const store = {
  /* ---- 设置 ---- */
  getSettings() {
    return deepMerge(DEFAULT_SETTINGS, settingsFile.data);
  },
  updateSettings(patch) {
    settingsFile.data = deepMerge(this.getSettings(), patch);
    settingsFile.flush();
    return this.getSettings();
  },

  /* ---- 关注列表 ---- */
  listWatch() {
    return watchFile.data.items;
  },
  getWatch(id) {
    return watchFile.data.items.find((i) => i.id === id) || null;
  },
  findWatchBySku(sku, condition = 'New') {
    return watchFile.data.items.find(
      (i) => i.sku === String(sku) && (i.condition || 'New') === condition
    ) || null;
  },
  addWatch(item) {
    const existing = this.findWatchBySku(item.sku, item.condition || 'New');
    if (existing) return { item: existing, created: false };
    const row = {
      id: uid('w_'),
      sku: String(item.sku),
      name: item.name || `SKU ${item.sku}`,
      image: item.image || null,
      url: item.url || `https://www.bestbuy.com/site/-/${item.sku}.p?skuId=${item.sku}`,
      modelNumber: item.modelNumber || null,
      manufacturer: item.manufacturer || null,
      condition: item.condition || 'New',
      category: item.category || null,
      specs: item.specs || null,
      source: item.source || 'api',
      targetPrice: item.targetPrice ?? null,
      enabled: true,
      note: item.note || '',
      addedAt: Date.now(),
      lastCheckedAt: null,
      lastError: null,
      current: item.current || null,
      first: null,
      low: null,
      high: null,
      checks: 0,
      drops: 0,
    };
    watchFile.data.items.unshift(row);
    watchFile.flush();
    return { item: row, created: true };
  },
  updateWatch(id, patch) {
    const item = this.getWatch(id);
    if (!item) return null;
    Object.assign(item, patch);
    watchFile.save();
    return item;
  },
  removeWatch(id) {
    const idx = watchFile.data.items.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    watchFile.data.items.splice(idx, 1);
    watchFile.flush();
    observations.prune((o) => o.itemId !== id);
    return true;
  },
  flushWatch() {
    watchFile.flush();
  },

  /* ---- 自动搜索 ---- */
  listSearches() {
    return searchFile.data.items;
  },
  getSearch(id) {
    return searchFile.data.items.find((s) => s.id === id) || null;
  },
  addSearch(s) {
    const row = {
      id: uid('s_'),
      name: s.name || '未命名搜索',
      enabled: s.enabled !== false,
      channel: s.channel || 'api',        // api | openbox
      kind: s.kind === 'hardware' ? 'hardware' : 'computer',   // 整机 or 单件硬件
      // 去哪家查。白名单挡住乱值，免得写进一个没有 provider 的零售商
      retailer: ['bh', 'amazon'].includes(s.retailer) ? s.retailer : 'bestbuy',
      part: s.part || null,                                     // B&H 用分类页，指明品类
      categoryId: s.categoryId || '',
      keywords: s.keywords || '',
      condition: s.condition || 'any',
      minPrice: s.minPrice ?? null,
      maxPrice: s.maxPrice ?? null,
      minPercentOff: s.minPercentOff ?? 0,
      onSaleOnly: !!s.onSaleOnly,
      sort: s.sort || 'percentSavings.desc',
      limit: s.limit || 40,
      createdAt: Date.now(),
      lastRunAt: null,
      lastCount: null,
      lastError: null,
    };
    searchFile.data.items.push(row);
    searchFile.flush();
    return row;
  },
  updateSearch(id, patch) {
    const s = this.getSearch(id);
    if (!s) return null;
    Object.assign(s, patch);
    searchFile.save();
    return s;
  },
  removeSearch(id) {
    const idx = searchFile.data.items.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    searchFile.data.items.splice(idx, 1);
    searchFile.flush();
    return true;
  },
  flushSearches() {
    searchFile.flush();
  },

  /* ---- 电脑榜：每台机器一行的实时快照 ---- */
  /**
   * 榜单主键。**必须带零售商** —— Best Buy 的 SKU 是 7-8 位，
   * Micro Center / Newegg 的商品 ID 位数完全重叠，不带零售商必然撞号，
   * 两家的同一个号会在榜上互相覆盖、价格轨迹混成一锅。
   * 缺 retailer 时兜底成 bestbuy，老数据和老 provider 都还能对上。
   */
  boardKey(p) {
    return `${p.retailer || 'bestbuy'}|${p.sku}|${p.condition || 'New'}`;
  },
  /**
   * 写入一次观测。返回 { isNew, dropped, prevPrice, wasInStock, row }，
   * 由调用方决定要不要生成事件/通知。wasInStock 是这次之前的有货状态（新行为 null），
   * 快速盯梢靠它认出「重新有货」。
   */
  upsertBoard(p, searchId) {
    const key = this.boardKey(p);
    const now = Date.now();
    const old = boardFile.data.rows[key] || null;
    const price = p.price;
    const regular = p.regularPrice ?? old?.regularPrice ?? null;
    // 折扣一律从"原价 vs 现价"现算，保证和表格里显示的价格对得上，
    // 不然接口给的 percentSavings 和我们记的价格会各说各话
    const percentOff =
      regular && price != null && regular > price
        ? Math.round(((regular - price) / regular) * 1000) / 10
        : 0;

    const row = {
      key,
      sku: p.sku,
      // 零售商既进主键也要**存进行里** —— 界面要按它分列/筛选。
      // 漏了这个字段会让新入榜的行 retailer=undefined（迁移补过的老行反而有），
      // 界面上就成了一半有一半没有。
      retailer: p.retailer || old?.retailer || 'bestbuy',
      name: p.name,
      url: p.url,
      image: p.image,
      condition: p.condition || 'New',
      category: p.category || null,
      manufacturer: p.manufacturer || null,
      specs: p.specs || old?.specs || null,
      price,
      regularPrice: regular,
      percentOff,
      inStock: p.inStock !== false,
      rating: p.rating ?? old?.rating ?? null,
      reviews: p.reviews ?? old?.reviews ?? null,
      thirdParty: p.thirdParty ?? old?.thirdParty ?? false,
      source: p.source || 'api',

      prevPrice: old ? old.price : null,
      minPrice: old ? Math.min(old.minPrice ?? old.price, price) : price,
      minPriceTs: old && (old.minPrice ?? Infinity) <= price ? old.minPriceTs : now,
      maxPrice: old ? Math.max(old.maxPrice ?? old.price, price) : price,
      firstSeenAt: old?.firstSeenAt ?? now,
      firstPrice: old?.firstPrice ?? price,
      lastSeenAt: now,
      lastDropAt: old?.lastDropAt ?? null,
      drops: old?.drops ?? 0,
      seenCount: (old?.seenCount ?? 0) + 1,
      // 上一个历史低点。用来判断"这次是不是真的破了纪录"，
      // 否则刚跟踪两轮的机器都会被标成新低。
      prevMinPrice: old ? (old.minPrice ?? old.price) : null,
      searchIds: [...new Set([...(old?.searchIds || []), searchId].filter(Boolean))],
    };

    const isNew = !old;
    const dropped = !!old && price < old.price;
    if (dropped) {
      row.lastDropAt = now;
      row.drops = (old.drops || 0) + 1;
    }

    boardFile.data.rows[key] = row;
    boardFile.save();
    return { isNew, dropped, prevPrice: old?.price ?? null, wasInStock: old ? old.inStock !== false : null, row };
  },
  listBoard() {
    return Object.values(boardFile.data.rows);
  },

  /* ---- 价格轨迹 ---- */
  /**
   * 记一个价格点。和上一个点同价就不写 —— 阶梯序列只需要拐点。
   * @returns true 表示确实写了新点
   */
  recordPrice(key, price, ts = Date.now()) {
    if (!key || price == null) return false;
    let arr = priceIndex.get(key);
    if (!arr) priceIndex.set(key, (arr = []));
    const last = arr[arr.length - 1];
    if (last && last.p === price) return false;
    const point = { t: ts, p: price };
    arr.push(point);
    priceLog.append({ k: key, t: ts, p: price });
    return true;
  },
  pricesFor(key) {
    return priceIndex.get(key) || [];
  },
  /**
   * 某个价格是从什么时候开始挂出来的。
   *
   * pricelog 只记拐点，所以「最后一个 价==price 且 t<=beforeTs 的点」就是
   * 这一段价格的起点。给历史记录里的降价事件用：左边显示旧价起于何时，
   * 就能一眼看出"这个价挂了多久才降"。
   *
   * 注意别拿 board.lastSeenAt 当"降价前的时间"——那只是上一轮轮询，
   * 两个时间永远只差一个查询间隔，屏幕上全是 10 分钟，毫无信息量。
   *
   * @returns {number|null} null = 轨迹里找不到（比如已被 prunePriceLog 清掉）
   */
  priceSegmentStart(key, price, beforeTs = Date.now()) {
    if (!key || price == null) return null;
    const arr = priceIndex.get(key);
    if (!arr) return null;
    // 倒着找：命中的是紧挨着这次事件的那一段，而不是更早的同价段
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].t <= beforeTs && arr[i].p === price) return arr[i].t;
    }
    return null;
  },
  prunePriceLog(days) {
    const cutoff = Date.now() - days * 86400000;
    // 每台机器要留住"窗口开始之前的最后一个点"，否则一台长期不变价的机器
    // 会被清成空历史，分位直接算不出来
    const keep = new Set();
    for (const [key, arr] of priceIndex) {
      const lastBefore = [...arr].reverse().find((p) => p.t < cutoff);
      if (lastBefore) keep.add(`${key}@${lastBefore.t}`);
      const kept = arr.filter((p) => p.t >= cutoff || keep.has(`${key}@${p.t}`));
      if (kept.length) priceIndex.set(key, kept);
      else priceIndex.delete(key);
    }
    return priceLog.prune((r) => r.t >= cutoff || keep.has(`${r.k}@${r.t}`));
  },
  /**
   * 给老配置补种新增的种子搜索。
   *
   * seedSearches() 只在 searches.json **不存在**时才跑，所以升级上来的用户
   * 永远拿不到后来新加的种子（"显卡"就是这么漏的）。这里按 id 补齐，
   * 并把处理过的 id 记进设置 —— 用户主动删掉之后不会又被塞回来。
   */
  ensureSeedSearches() {
    const already = new Set(this.getSettings().seededSearchIds || []);
    const have = new Set(searchFile.data.items.map((x) => x.id));
    const added = [];
    const seen = [];
    for (const seed of seedSearches()) {
      seen.push(seed.id);
      if (have.has(seed.id) || already.has(seed.id)) continue;
      searchFile.data.items.push(seed);
      added.push(seed);
    }
    // 就算这次没补，也要把已存在的种子 id 记下来，否则用户删掉后下次又会冒出来
    const merged = [...new Set([...already, ...seen])];
    if (added.length || merged.length !== already.size) {
      if (added.length) searchFile.flush();
      this.updateSettings({ seededSearchIds: merged });
    }
    return added.map((s) => s.name);
  },

  /**
   * 把老的两段式 boardKey（`sku|condition`）迁成带零售商的三段式
   * （`retailer|sku|condition`）。
   *
   * 必须三处一起改：board.json 的键、pricelog 的 k、events 的 boardKey。
   * 漏掉任何一处，"历史分位"和"旧价起于何时"就会因为对不上键而全部变成"—"。
   * 只跑一次，靠 settings.retailerKeysMigrated 记录。
   */
  migrateRetailerKeys() {
    if (this.getSettings().retailerKeysMigrated) return null;

    const isOld = (k) => String(k).split('|').length === 2;
    const upgrade = (k) => (isOld(k) ? `bestbuy|${k}` : k);

    // 1) 榜单
    const nextRows = {};
    let movedRows = 0;
    for (const [k, row] of Object.entries(boardFile.data.rows)) {
      const nk = upgrade(k);
      if (nk !== k) movedRows++;
      nextRows[nk] = { ...row, key: nk, retailer: row.retailer || 'bestbuy' };
    }
    boardFile.data.rows = nextRows;
    boardFile.flush();

    // 2) 价格轨迹（内存索引和文件都要换）
    let movedPoints = 0;
    const nextLog = priceLog.rows.map((r) => {
      if (!r?.k || !isOld(r.k)) return r;
      movedPoints++;
      return { ...r, k: upgrade(r.k) };
    });
    priceLog.replaceAll(nextLog);
    priceIndex.clear();
    for (const r of nextLog) {
      if (!r?.k) continue;
      let arr = priceIndex.get(r.k);
      if (!arr) priceIndex.set(r.k, (arr = []));
      arr.push({ t: r.t, p: r.p });
    }
    for (const arr of priceIndex.values()) arr.sort((a, b) => a.t - b.t);

    // 3) 事件里的 boardKey（"旧价起于"靠它去 pricelog 里查）
    let movedEvents = 0;
    const nextEvents = events.rows.map((e) => {
      if (!e?.boardKey || !isOld(e.boardKey)) return e;
      movedEvents++;
      return { ...e, boardKey: upgrade(e.boardKey) };
    });
    events.replaceAll(nextEvents);

    this.updateSettings({ retailerKeysMigrated: true });
    return { movedRows, movedPoints, movedEvents };
  },

  /**
   * 给缺 retailer 的榜单行补上。键的第一段就是零售商，直接回填。
   * 每次启动都跑（很便宜、幂等）—— 早期版本的 upsertBoard 漏存这个字段，
   * 导致新入榜的行没有而迁移过的老行有，界面上一半有一半没有。
   */
  backfillRetailer() {
    let fixed = 0;
    for (const [key, row] of Object.entries(boardFile.data.rows)) {
      if (row.retailer) continue;
      const seg = String(key).split('|');
      row.retailer = seg.length >= 3 ? seg[0] : 'bestbuy';
      fixed++;
    }
    if (fixed) boardFile.flush();
    return fixed;
  },

  /** 榜单里已有的机器补上起点，别让"第一次装这个功能"的用户看到一片数据不足 */
  backfillPriceLog() {
    let added = 0;
    for (const row of Object.values(boardFile.data.rows)) {
      if (priceIndex.has(row.key)) continue;
      if (row.firstPrice != null && row.firstSeenAt) {
        if (this.recordPrice(row.key, row.firstPrice, row.firstSeenAt)) added++;
      }
      if (row.price != null && row.lastSeenAt) {
        if (this.recordPrice(row.key, row.price, row.lastSeenAt)) added++;
      }
    }
    return added;
  },
  /** 给"为什么还没有降价"这类空状态用的解释性统计 */
  boardStats() {
    const rows = Object.values(boardFile.data.rows);
    return {
      tracked: rows.length,
      rechecked: rows.filter((r) => (r.seenCount ?? 1) > 1).length,
      everDropped: rows.filter((r) => (r.drops ?? 0) > 0).length,
      oldestSeenAt: rows.length ? Math.min(...rows.map((r) => r.firstSeenAt || Date.now())) : null,
    };
  },
  getBoardRow(key) {
    return boardFile.data.rows[key] || null;
  },
  pruneBoard(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [k, v] of Object.entries(boardFile.data.rows)) {
      if ((v?.lastSeenAt || 0) < cutoff) {
        delete boardFile.data.rows[k];
        removed++;
      }
    }
    if (removed) boardFile.save();
    return removed;
  },
  clearBoard() {
    boardFile.data.rows = {};
    boardFile.flush();
  },

  /* ---- 事件(历史记录) ---- */
  addEvent(ev) {
    const row = { id: uid('e_'), ts: Date.now(), ...ev };
    events.append(row);
    return row;
  },
  listEvents({ limit = 200, offset = 0, type = null, q = '', since = null, sort = 'recent' } = {}) {
    let rows = events.rows;
    if (type && type !== 'all') {
      const types = type.split(',');
      rows = rows.filter((r) => types.includes(r.type));
    }
    if (since) rows = rows.filter((r) => r.ts >= since);
    if (q) {
      const needle = q.toLowerCase();
      rows = rows.filter(
        (r) =>
          (r.name || '').toLowerCase().includes(needle) ||
          (r.sku || '').includes(needle) ||
          (r.searchName || '').toLowerCase().includes(needle)
      );
    }
    // 补上"旧价是从什么时候开始挂的"。必须在排序**之前**做完 ——
    // 「挂价时长」这个排序键就是从它算出来的，等分页完再补就晚了。
    // 从 pricelog 现推，不往事件里存字段，所以老事件也能一并参与排序。
    rows = rows.map((e) => {
      if (e.prevPrice == null || !e.boardKey) return e;
      const prevTs = this.priceSegmentStart(e.boardKey, e.prevPrice, e.ts);
      return prevTs && prevTs < e.ts ? { ...e, prevTs } : e;
    });

    // 文件是追加写的，正常情况下插入顺序就是时间顺序，但补录/导入的数据可能乱序，
    // 所以哪怕按时间排也要真排一次。
    const cmp = EVENT_SORTS[sort] || EVENT_SORTS.recent;
    const sorted = [...rows].sort((a, b) => cmp(a, b) || b.ts - a.ts);

    // grandTotal / byType 是"没过滤"的全量。用来区分两种空：
    // 压根没有记录，还是有记录但当前筛选条件没命中。
    const byType = {};
    for (const r of events.rows) byType[r.type] = (byType[r.type] || 0) + 1;

    return {
      total: sorted.length,
      rows: sorted.slice(offset, offset + limit),
      grandTotal: events.rows.length,
      byType,
      sort: EVENT_SORTS[sort] ? sort : 'recent',
    };
  },
  clearEvents() {
    events.clear();
  },

  /* ---- 价格采样 ---- */
  addObservation(o) {
    return observations.append({ ts: Date.now(), ...o });
  },
  observationsFor(itemId, limit = 500) {
    const rows = observations.rows.filter((o) => o.itemId === itemId);
    return rows.slice(-limit);
  },
  pruneObservations(days) {
    const cutoff = Date.now() - days * 86400000;
    return observations.prune((o) => o.ts >= cutoff);
  },

  flushAll() {
    settingsFile.flush();
    watchFile.flush();
    searchFile.flush();
    boardFile.flush();
  },
};

process.on('exit', () => store.flushAll());
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flushAll();
    process.exit(0);
  });
}
