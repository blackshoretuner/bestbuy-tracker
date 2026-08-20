import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, PUBLIC_DIR, ROOT, SEED_CATEGORIES, CONDITIONS } from './src/config.js';
import { store } from './src/store.js';
import { tracker } from './src/tracker.js';
import {
  getProductBySku,
  pingApi,
  searchCategories,
  searchOpenBox,
  searchProducts,
} from './src/providers/bestbuyApi.js';
import { pingScrape, scrapeProduct } from './src/providers/scrape.js';
import { WebSession, pingWeb } from './src/providers/bestbuyWeb.js';
import { findBrowser } from './src/browser/cdp.js';
import { pingNotify } from './src/notify.js';
import { isComponent, isComputer, FORM_LABEL } from './src/specs.js';
import { buildTierIndex, crossSection, dealScore, historyPercentile } from './src/analytics.js';
import { csvEscape, getLogs, log, num, onLog, parseSkuFromInput } from './src/util.js';
import { clearPidFile, newToken, writePidFile } from './src/instance.js';

// 每次启动生成一个随机 token。控制脚本从 pid 文件里读到它才能调关机接口，
// 这样浏览器里某个网页就算知道端口也没法把服务 POST 关掉。
const INSTANCE_TOKEN = newToken();

/* ------------------------------------------------------------------ */
/* 极简路由                                                             */
/* ------------------------------------------------------------------ */
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const regex = new RegExp(
    '^' +
      pattern.replace(/:([A-Za-z0-9_]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$'
  );
  routes.push({ method, regex, keys, handler });
};

const json = (res, data, status = 200) => {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
};

const fail = (res, e, status = 500) => {
  const message = e?.friendly || e?.message || String(e);
  json(res, { ok: false, error: message, code: e?.code || null }, status);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */
const sseClients = new Set();

function broadcast(type, payload) {
  const frame = `data: ${JSON.stringify({ type, payload, ts: Date.now() })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { sseClients.delete(res); }
  }
}

tracker.on('status', (s) => broadcast('status', s));
tracker.on('cycle', (s) => broadcast('cycle', s));
onLog((line) => broadcast('log', line));

/* ------------------------------------------------------------------ */
/* 通用：把设置里的 key 挡住                                            */
/* ------------------------------------------------------------------ */
function publicSettings() {
  const s = store.getSettings();
  const { apiKey, ...rest } = s;
  return { ...rest, hasApiKey: !!apiKey, apiKeyHint: apiKey ? `••••${apiKey.slice(-4)}` : '' };
}

/* ------------------------------------------------------------------ */
/* 路由定义                                                             */
/* ------------------------------------------------------------------ */
route('GET', '/api/bootstrap', async (req, res) => {
  json(res, {
    ok: true,
    settings: publicSettings(),
    status: tracker.status(),
    searches: store.listSearches(),
    watchCount: store.listWatch().length,
    boardCount: store.listBoard().length,
    browser: findBrowser(store.getSettings().browserPath),
    categories: SEED_CATEGORIES,
    conditions: CONDITIONS,
    formLabels: FORM_LABEL,
    dataDir: DATA_DIR,
  });
});

/* ---------------- 电脑榜 ---------------- */
const BOARD_SORTS = {
  price: (a, b) => (a.price ?? 1e9) - (b.price ?? 1e9),
  '-price': (a, b) => (b.price ?? -1) - (a.price ?? -1),
  drop: (a, b) => dropPct(b) - dropPct(a),
  recent: (a, b) => (b.lastDropAt || b.firstSeenAt || 0) - (a.lastDropAt || a.firstSeenAt || 0),
  name: (a, b) => String(a.specs?.shortName || a.name).localeCompare(String(b.specs?.shortName || b.name)),
  gpu: (a, b) => gpuRank(b) - gpuRank(a),
  ram: (a, b) => ramGb(b) - ramGb(a),
  weight: (a, b) => (weightKg(a) ?? 99) - (weightKg(b) ?? 99),
  // 硬件榜专用：显存最大 / 芯片最强（gpu 那个键对显卡同样适用）
  vram: (a, b) => vramGb(b) - vramGb(a),
  // 没数据的排最后，别让"算不出来"的混在好价里。
  // 分数并列时（历史还没攒够时会大量并列在 70 分）依次用同档分位、价格兜底，
  // 保证每次刷新顺序一致，不要看着像在随机跳。
  deal: (a, b) =>
    (b.deal?.score ?? -1) - (a.deal?.score ?? -1) ||
    (a.cross?.pct ?? 999) - (b.cross?.pct ?? 999) ||
    (a.price ?? 1e9) - (b.price ?? 1e9),
  hist: (a, b) => (a.hist?.enough ? a.hist.pct : 999) - (b.hist?.enough ? b.hist.pct : 999),
  cross: (a, b) => (a.cross?.pct ?? 999) - (b.cross?.pct ?? 999),
};

function dropPct(r) {
  if (!r.regularPrice || !r.price || r.regularPrice <= r.price) return 0;
  return ((r.regularPrice - r.price) / r.regularPrice) * 100;
}
function gpuRank(r) {
  const m = String(r.specs?.gpu || '').match(/(\d{4})/);
  if (!m) return 0;
  const n = Number(m[1]);
  return n + (/Ti|Super/i.test(r.specs.gpu) ? 5 : 0);
}
function ramGb(r) {
  return num(String(r.specs?.ram || '').match(/(\d+)G/)?.[1]) ?? 0;
}
function weightKg(r) {
  return num(String(r.specs?.weight || '').match(/([\d.]+)kg/)?.[1]);
}
function vramGb(r) {
  return num(String(r.specs?.vram || '').match(/(\d+)G/)?.[1]) ?? 0;
}

/**
 * 给每一行算「同档分位」和「历史分位」。
 * 同档索引必须在**全量**榜单上建（过滤之前），否则用户一勾"只看笔电"，
 * 对比样本就跟着缩水，分位跟着乱跳。
 */
function annotate(rows, allRows) {
  const s = store.getSettings();
  const index = buildTierIndex(allRows);
  const now = Date.now();

  return rows.map((r) => {
    // 硬件用更低的样本门槛：同一颗芯片+同显存是精确同款对比，
    // 不像整机那样是"配置相近"的近似分组（见 config.js 的注释）
    const minN = isComponent(r.specs || {})
      ? s.crossMinSamplesHardware || 3
      : s.crossMinSamples || 5;
    const cross = crossSection(r, index, { minN });
    const hist = historyPercentile(store.pricesFor(r.key), r.price, {
      windowDays: s.histWindowDays || 90,
      minDays: s.histMinDays || 3,
      now,
    });
    const deal = dealScore(cross, hist);
    if (deal && deal.basis === 'both') {
      deal.trueDeal =
        hist.pct <= (s.trueDealHistPct ?? 15) && cross.pct <= (s.trueDealCrossPct ?? 35);
    }
    return { ...r, cross, hist, deal };
  });
}

route('GET', '/api/board', async (req, res, _p, query) => {
  let allRows = store.listBoard();

  // 隐藏第三方卖家。这个设置以前只在入库时生效（tracker.js），挡得住新数据，
  // 挡不住改设置之前就已经收进榜的那些 —— 勾了以后界面上一台没少，看着像坏了。
  // 从"能看到的"和"拿来比价的"两处一起剔除：不打算买的机器，不该出现在
  // 同档分位的样本里，更不该被当成"同档更便宜的替代选项"推给用户。
  // 整机榜和硬件榜是两个互不相干的池子。**先**按 kind 分池，再统计/剔除三方 ——
  // 反过来的话，硬件页会显示整机那边的三方条数（实测显示"已隐藏三方 29"，
  // 而硬件榜里一条三方都没有），计数和空态文案全跟着说错话。
  const kind = query.get('kind') === 'hardware' ? 'hardware' : 'computer';
  allRows = allRows.filter((r) =>
    kind === 'hardware' ? isComponent(r.specs || {}) : !isComponent(r.specs || {})
  );

  // 同 tracker.js：「隐藏三方」只管整机。散装配件几乎全是 Marketplace
  //（内存 100%、CPU 92%），在硬件页也照这条隐藏的话，收进来了照样看不见。
  const hiddenThirdParty =
    kind === 'computer' && store.getSettings().hideThirdParty
      ? allRows.filter((r) => r.thirdParty).length
      : 0;
  if (hiddenThirdParty) allRows = allRows.filter((r) => !r.thirdParty);

  let rows = allRows;

  const q = (query.get('q') || '').trim().toLowerCase();
  if (q) {
    const words = q.split(/\s+/);
    rows = rows.filter((r) => {
      const hay = [
        r.name, r.sku, r.condition, r.manufacturer,
        r.specs?.shortName, r.specs?.cpu, r.specs?.gpu, r.specs?.ram, r.specs?.disk,
      ].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  const form = query.get('form');
  if (form && form !== 'all') rows = rows.filter((r) => (r.specs?.form || 'other') === form);

  const cond = query.get('condition');
  if (cond === 'new') rows = rows.filter((r) => /^new$/i.test(r.condition));
  else if (cond === 'used') rows = rows.filter((r) => !/^new$/i.test(r.condition));

  const maxPrice = num(query.get('maxPrice'));
  if (maxPrice !== null) rows = rows.filter((r) => (r.price ?? 1e9) <= maxPrice);
  const minPrice = num(query.get('minPrice'));
  if (minPrice !== null) rows = rows.filter((r) => (r.price ?? 0) >= minPrice);

  if (query.get('onlyDrops') === '1') rows = rows.filter((r) => r.prevPrice && r.price < r.prevPrice);
  if (query.get('onlyDeals') === '1') rows = rows.filter((r) => dropPct(r) > 0);
  if (query.get('inStock') === '1') rows = rows.filter((r) => r.inStock !== false);

  // 分位要在排序和"真好价"筛选之前算出来
  rows = annotate(rows, allRows);

  if (query.get('trueDeal') === '1') rows = rows.filter((r) => r.deal?.trueDeal);
  const maxHist = num(query.get('maxHistPct'));
  if (maxHist !== null) rows = rows.filter((r) => r.hist?.enough && r.hist.pct <= maxHist);
  const maxCross = num(query.get('maxCrossPct'));
  if (maxCross !== null) rows = rows.filter((r) => r.cross && r.cross.pct <= maxCross);

  const sort = BOARD_SORTS[query.get('sort')] ? query.get('sort') : 'price';
  rows = [...rows].sort(BOARD_SORTS[sort]);

  const limit = Math.min(num(query.get('limit')) || 300, 2000);
  const watched = new Set(store.listWatch().map((w) => `${w.sku}|${w.condition}`));

  json(res, {
    ok: true,
    total: rows.length,
    sort,
    // 让 UI 能说清"多少台已经攒够历史了"
    stats: {
      withHist: rows.filter((r) => r.hist?.enough).length,
      withCross: rows.filter((r) => r.cross).length,
      trueDeals: rows.filter((r) => r.deal?.trueDeal).length,
      // 重量只写在商品详情页的规格表里，网页通道取不到（详情页会拒绝我们）。
      // 统计的是**过滤前**的全榜，免得用户随手筛出几台没重量的就把整列收了。
      withWeight: allRows.filter((r) => r.specs?.weight).length,
      hiddenThirdParty,
    },
    rows: rows.slice(0, limit).map((r) => ({ ...r, watched: watched.has(r.key) })),
  });
});

route('POST', '/api/board/clear', async (req, res) => {
  store.clearBoard();
  json(res, { ok: true });
});

/* ---------------- 历史记录 ---------------- */
route('GET', '/api/events', async (req, res, _p, query) => {
  const out = store.listEvents({
    limit: Math.min(num(query.get('limit')) || 200, 2000),
    offset: num(query.get('offset')) || 0,
    type: query.get('type') || 'all',
    q: query.get('q') || '',
    since: num(query.get('since')),
    // prevTs 的补齐和排序都在 store.listEvents 里做 —— 「挂价时长」这个排序键
    // 依赖 prevTs，必须在分页之前就算好
    sort: query.get('sort') || 'recent',
  });
  // 带上榜单统计，前端才能解释清楚"为什么筛出来是空的"
  json(res, { ok: true, ...out, board: store.boardStats() });
});

route('POST', '/api/events/clear', async (req, res) => {
  store.clearEvents();
  json(res, { ok: true });
});

route('GET', '/api/events/export.csv', async (req, res) => {
  const { rows } = store.listEvents({ limit: 20000 });
  const header = [
    '时间', '类型', 'SKU', '名称', 'CPU', 'GPU', '内存', '硬盘', '重量',
    '品相', '原价', '旧价', '现价', '降幅', '降幅%', '来源', '备注', '链接',
  ];
  const lines = [header.join(',')];
  for (const e of rows) {
    lines.push([
      new Date(e.ts).toLocaleString('zh-CN'),
      e.type, e.sku, e.name,
      e.specs?.cpu, e.specs?.gpu, e.specs?.ram, e.specs?.disk, e.specs?.weight,
      e.condition, e.regularPrice, e.prevPrice, e.price, e.delta, e.pct,
      e.searchName || '关注列表', e.note, e.url,
    ].map(csvEscape).join(','));
  }
  const body = '﻿' + lines.join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="bestbuy-history-${Date.now()}.csv"`,
  });
  res.end(body);
});

/* ---------------- 关注列表 ---------------- */
route('GET', '/api/watch', async (req, res) => {
  json(res, { ok: true, items: store.listWatch() });
});

route('POST', '/api/watch', async (req, res) => {
  const body = await readBody(req);
  const settings = store.getSettings();

  // 从榜里直接关注
  if (body.boardKey) {
    const row = store.getBoardRow(body.boardKey);
    if (!row) return fail(res, new Error('榜单里没有这一行'), 404);
    const { item, created } = store.addWatch({
      sku: row.sku, name: row.name, image: row.image, url: row.url,
      condition: row.condition, category: row.category, specs: row.specs,
      manufacturer: row.manufacturer, targetPrice: body.targetPrice ?? null,
      current: { price: row.price, regularPrice: row.regularPrice, onSale: row.percentOff > 0, inStock: row.inStock, ts: Date.now() },
    });
    if (created && row.price != null) {
      store.updateWatch(item.id, {
        first: { price: row.price, ts: Date.now() },
        low: { price: row.price, ts: Date.now() },
        high: { price: row.price, ts: Date.now() },
      });
    }
    return json(res, { ok: true, item: store.getWatch(item.id), created });
  }

  const sku = parseSkuFromInput(body.input || body.sku || body.url);
  if (!sku) return fail(res, new Error('没解析出 SKU，请贴商品链接或直接填 SKU 数字'), 400);

  let product = null;
  try {
    if (settings.apiKey && settings.provider !== 'scrape' && settings.provider !== 'web') {
      product = await getProductBySku(sku, settings.apiKey, tracker.apiLimiter);
    }
    if (!product && (settings.provider === 'web' || settings.provider === 'auto')) {
      const session = new WebSession(settings);
      try {
        // 详情页取不到，只能拿链接 slug 里的型号去搜索里认领
        product = await session.findBySku(sku, { url: body.input || body.url || '' });
      } finally {
        await session.close().catch(() => {});
      }
      if (!product) {
        return fail(
          res,
          new Error(
            '浏览器通道没能定位这台机器。请贴完整的商品链接（带型号那种长网址），' +
              '或者直接在「电脑榜」里点 ☆ 收藏 —— 那条路最稳。'
          ),
          404
        );
      }
    }
    if (!product && settings.provider === 'scrape') {
      product = await tracker.scrapeLimiter(() => scrapeProduct(sku));
    }
  } catch (e) {
    return fail(res, e, 400);
  }

  if (!product) return fail(res, new Error(`没查到 SKU ${sku}（确认这个 SKU 在 bestbuy.com 上存在）`), 404);

  const { item, created } = store.addWatch({
    sku: product.sku, name: product.name, image: product.image, url: product.url,
    condition: product.condition, category: product.category, specs: product.specs,
    manufacturer: product.manufacturer, modelNumber: product.modelNumber,
    source: product.source, targetPrice: body.targetPrice ?? null,
  });
  json(res, { ok: true, item, created, product });
});

route('PATCH', '/api/watch/:id', async (req, res, params) => {
  const body = await readBody(req);
  const allowed = ['targetPrice', 'enabled', 'note', 'name'];
  const patch = {};
  for (const k of allowed) if (k in body) patch[k] = body[k];
  const item = store.updateWatch(params.id, patch);
  if (!item) return fail(res, new Error('没找到'), 404);
  store.flushWatch();
  json(res, { ok: true, item });
});

route('DELETE', '/api/watch/:id', async (req, res, params) => {
  json(res, { ok: store.removeWatch(params.id) });
});

route('GET', '/api/watch/:id/history', async (req, res, params) => {
  const item = store.getWatch(params.id);
  if (!item) return fail(res, new Error('没找到'), 404);
  json(res, { ok: true, item, points: store.observationsFor(params.id, 800) });
});

/* ---------------- 自动搜索 ---------------- */
route('GET', '/api/searches', async (req, res) => {
  json(res, { ok: true, items: store.listSearches() });
});

route('POST', '/api/searches', async (req, res) => {
  json(res, { ok: true, item: store.addSearch(await readBody(req)) });
});

route('PATCH', '/api/searches/:id', async (req, res, params) => {
  const item = store.updateSearch(params.id, await readBody(req));
  if (!item) return fail(res, new Error('没找到'), 404);
  store.flushSearches();
  json(res, { ok: true, item });
});

route('DELETE', '/api/searches/:id', async (req, res, params) => {
  json(res, { ok: store.removeSearch(params.id) });
});

route('POST', '/api/searches/:id/run', async (req, res, params) => {
  const s = store.getSearch(params.id);
  if (!s) return fail(res, new Error('没找到'), 404);
  try {
    const result = await tracker.runSearchOnce(s, store.getSettings(), { record: true });
    broadcast('board', { changed: true });
    json(res, {
      ok: true,
      count: result.products.length,
      newCount: result.newCount,
      dropCount: result.dropCount,
      meta: result.meta,
    });
  } catch (e) {
    fail(res, e, 400);
  }
});

/* ---------------- 即时预览（不写历史） ---------------- */
route('GET', '/api/preview', async (req, res, _p, query) => {
  const settings = store.getSettings();
  const q = {
    channel: query.get('channel') || 'api',
    categoryId: query.get('categoryId') || '',
    keywords: query.get('keywords') || '',
    condition: query.get('condition') || 'any',
    minPrice: num(query.get('minPrice')),
    maxPrice: num(query.get('maxPrice')),
    minPercentOff: num(query.get('minPercentOff')) || 0,
    onSaleOnly: query.get('onSaleOnly') === '1',
    sort: query.get('sort') || 'percentSavings.desc',
    limit: Math.min(num(query.get('limit')) || 40, 100),
  };
  try {
    let products = [];
    let meta = {};
    if (settings.provider === 'web' || (settings.provider === 'auto' && !settings.apiKey)) {
      const session = new WebSession(settings);
      try {
        products = await session.search({
          categoryId: q.categoryId,
          keywords: q.keywords,
          condition: q.channel === 'openbox' ? 'openbox' : q.condition,
          limit: q.limit,
          maxPages: settings.maxPagesPerSearch || 2,
        });
      } finally {
        await session.close().catch(() => {});
      }
      if (q.maxPrice != null) products = products.filter((p) => p.price <= q.maxPrice);
      if (q.minPrice != null) products = products.filter((p) => p.price >= q.minPrice);
      if (q.minPercentOff) products = products.filter((p) => (p.percentOff ?? 0) >= q.minPercentOff);
      meta = { channel: 'web' };
    } else if (q.channel === 'openbox') {
      const r = await searchOpenBox(q, settings.apiKey, tracker.apiLimiter);
      if (!r.available) return fail(res, new Error(`Open Box 接口不可用：${r.reason}`), 502);
      products = r.products;
      meta = { endpoint: r.endpoint };
    } else {
      const r = await searchProducts(q, settings.apiKey, tracker.apiLimiter);
      products = r.products;
      meta = { droppedFilters: r.droppedFilters, appliedClientSide: r.appliedClientSide, total: r.total };
    }
    if (query.get('onlyComputers') !== '0' && settings.onlyComputers) {
      const before = products.length;
      const keep = query.get('kind') === 'hardware' ? isComponent : isComputer;
      products = products.filter((p) => keep(p.specs || {}));
      meta.filteredOut = before - products.length;
    }
    json(res, { ok: true, products, meta });
  } catch (e) {
    fail(res, e, 400);
  }
});

/* ---------------- 分类查找 ---------------- */
route('GET', '/api/categories', async (req, res, _p, query) => {
  const q = query.get('q');
  if (!q) return json(res, { ok: true, categories: SEED_CATEGORIES });
  try {
    json(res, { ok: true, categories: await searchCategories(q, store.getSettings().apiKey, tracker.apiLimiter) });
  } catch (e) {
    fail(res, e, 400);
  }
});

/* ---------------- 设置 ---------------- */
route('GET', '/api/settings', async (req, res) => json(res, { ok: true, settings: publicSettings() }));

route('PUT', '/api/settings', async (req, res) => {
  const body = await readBody(req);
  // 前端留空表示"不改动已有 key"
  if (body.apiKey === '' || body.apiKey === undefined) delete body.apiKey;
  delete body.hasApiKey;
  delete body.apiKeyHint;
  store.updateSettings(body);
  tracker.restart();
  json(res, { ok: true, settings: publicSettings(), status: tracker.status() });
});

/* ---------------- 调度控制 ---------------- */
route('POST', '/api/tracker/start', async (req, res) => json(res, { ok: true, status: tracker.start() }));
route('POST', '/api/tracker/stop', async (req, res) => json(res, { ok: true, status: tracker.stop() }));
route('POST', '/api/tracker/run', async (req, res) => {
  tracker.runCycle('手动').then(() => broadcast('board', { changed: true })).catch(() => {});
  json(res, { ok: true, status: tracker.status() });
});
route('GET', '/api/status', async (req, res) => json(res, { ok: true, status: tracker.status() }));

/* ---------------- 实例控制（给 bbt 控制脚本用） ---------------- */
route('GET', '/api/instance', async (req, res) => {
  json(res, {
    ok: true,
    app: 'bestbuy-price-tracker',
    pid: process.pid,
    port: PORT,
    startedAt: START_TIME,
    // 装在哪个目录。便携版会被拷来拷去，同一台机器上可能同时有好几份，
    // 控制脚本靠这个分辨"端口上答话的是不是我这份"
    root: ROOT,
    dataDir: DATA_DIR,
    running: tracker.status().running,
  });
});

route('POST', '/api/shutdown', async (req, res) => {
  if (req.headers['x-bbt-token'] !== INSTANCE_TOKEN) {
    return json(res, { ok: false, error: '缺少或错误的实例 token' }, 403);
  }
  json(res, { ok: true, pid: process.pid });
  log.info('收到关机指令，正在保存数据…');
  // 先把响应发出去，再收摊：停调度、落盘、关连接
  setTimeout(() => {
    try { tracker.stop(); } catch { /* ignore */ }
    try { store.flushAll(); } catch { /* ignore */ }
    for (const c of sseClients) { try { c.end(); } catch { /* ignore */ } }
    sseClients.clear();
    server.close(() => {
      clearPidFile();
      process.exit(0);
    });
    // 有连接赖着不走就硬退，但数据已经落盘了
    setTimeout(() => { clearPidFile(); process.exit(0); }, 3000).unref();
  }, 60);
});

/* ---------------- 诊断 ---------------- */
route('GET', '/api/logs', async (req, res, _p, query) => {
  json(res, { ok: true, lines: getLogs(Math.min(num(query.get('limit')) || 200, 600)) });
});

route('POST', '/api/diagnose', async (req, res) => {
  const body = await readBody(req).catch(() => ({}));
  const which = body.target || 'all';
  const out = {};
  const s = store.getSettings();
  if (which === 'all' || which === 'web') out.web = await pingWeb(s).catch((e) => ({ ok: false, detail: e.message }));
  if (which === 'all' || which === 'api') out.api = await pingApi(s.apiKey).catch((e) => ({ ok: false, detail: e.message }));
  if (which === 'scrape') out.scrape = await pingScrape();
  if (which === 'all' || which === 'notify') out.notify = await pingNotify();
  json(res, { ok: true, results: out });
});

/* ------------------------------------------------------------------ */
/* 静态文件                                                             */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  // 防目录穿越
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* 服务器                                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // SSE
  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', payload: tracker.status() })}\n\n`);
    sseClients.add(res);
    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 25000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.regex);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try {
        await r.handler(req, res, params, url.searchParams);
      } catch (e) {
        log.error(`${req.method} ${url.pathname} 出错`, e.message);
        if (!res.headersSent) fail(res, e);
      }
      return;
    }
    return json(res, { ok: false, error: '接口不存在' }, 404);
  }

  serveStatic(req, res, url.pathname);
});

const settings = store.getSettings();
const PORT = Number(process.env.PORT) || settings.port || 8787;
const START_TIME = Date.now();

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  writePidFile({ port: PORT, token: INSTANCE_TOKEN, url });
  log.info(`Best Buy 降价雷达已启动 → ${url}`);
  log.info(`数据目录：${DATA_DIR}`);
  // 老用户升级上来时，用榜单里已有的首见价/现价给价格轨迹补个起点
  // 老数据的 boardKey 迁成带零售商的三段式（board/pricelog/events 三处一起）
  const mig = store.migrateRetailerKeys();
  if (mig) log.info(`boardKey 已迁移带零售商：榜单 ${mig.movedRows} 行、价格点 ${mig.movedPoints} 个、事件 ${mig.movedEvents} 条`);

  // 升级上来的配置补种新种子（"显卡"这类后加的搜索）
  const seeded = store.ensureSeedSearches();
  if (seeded.length) log.info(`已补种新的自动搜索：${seeded.join('、')}`);
  const filled = store.backfillPriceLog();
  if (filled) log.info(`价格轨迹补录 ${filled} 个历史点`);
  // 同样别拿"没有 API Key"当问题——默认的浏览器通道本来就不需要它
  const onWeb = settings.provider === 'web' || (settings.provider === 'auto' && !settings.apiKey);
  if (settings.provider === 'api' && !settings.apiKey) {
    log.warn('通道选的是「官方 API」但没填 Key。去设置里换成「浏览器读网页」，或者填入 Key');
  } else if (onWeb) {
    const b = findBrowser(settings.browserPath);
    if (b) log.info(`数据通道：浏览器读网页（${b.name}）`);
    else log.warn('没找到 Edge 或 Chrome，浏览器通道用不了。装一个，或改用官方 API 通道');
  }
  if (settings.autoStart) tracker.start();
  if (settings.openBrowserOnStart && process.env.BBT_NO_OPEN !== '1') {
    try {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch { /* 打不开就算了 */ }
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log.error(`端口 ${PORT} 被占用。换个端口：bbt port 9000`);
  } else {
    log.error('服务启动失败', e.message);
  }
  process.exit(1);
});

// Ctrl+C / 关窗口 / bbt stop 兜底：任何退出路径都别把 pid 文件留下当垃圾
process.on('exit', () => clearPidFile());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => {
    log.info(`收到 ${sig}，正在退出…`);
    try { store.flushAll(); } catch { /* ignore */ }
    clearPidFile();
    process.exit(0);
  });
}
