/**
 * Best Buy 官方开放平台客户端 (https://developer.bestbuy.com)
 *
 * 这是"最稳妥"的通道：合规、有明确的限速配额(约 5 req/s、50k/日)、
 * 返回结构化的 salePrice / regularPrice / onSale / percentSavings / condition。
 *
 * 所有函数都做了防御性处理：Best Buy 偶尔会调整可过滤字段，遇到 400
 * 会自动去掉可疑过滤条件重试，并在返回值里说明"哪些条件被丢弃了"，
 * 而不是直接把整轮查询打挂。
 */
import { HttpError, httpJson, log, money, num } from '../util.js';
import { extractSpecs } from '../specs.js';

const API_BASE = 'https://api.bestbuy.com';

const PRODUCT_SHOW = [
  'sku',
  'name',
  'manufacturer',
  'modelNumber',
  'condition',
  'url',
  'addToCartUrl',
  'image',
  'thumbnailImage',
  'regularPrice',
  'salePrice',
  'onSale',
  'percentSavings',
  'dollarSavings',
  'customerReviewAverage',
  'customerReviewCount',
  'onlineAvailability',
  'inStoreAvailability',
  'orderable',
  'categoryPath.name',
  // 规格拆列（cpu/gpu/内存/硬盘/重量）全靠这两个字段
  'details.name',
  'details.value',
].join(',');

const CONDITION_FILTER = {
  new: 'New',
  refurbished: 'Refurbished',
  preowned: 'Pre-Owned',
};

const CONDITION_LABEL = {
  New: '全新',
  Refurbished: '官翻',
  'Pre-Owned': '二手',
  'Open-Box': 'Open Box',
};

export function conditionLabel(c) {
  return CONDITION_LABEL[c] || c || '全新';
}

export class ApiKeyMissingError extends Error {
  constructor() {
    super('未配置 Best Buy API Key，请到「设置」里填入（developer.bestbuy.com 免费申请）');
    this.code = 'NO_API_KEY';
  }
}

function requireKey(apiKey) {
  if (!apiKey || !String(apiKey).trim()) throw new ApiKeyMissingError();
  return String(apiKey).trim();
}

function describeApiError(e) {
  if (e instanceof HttpError) {
    if (e.status === 403) return 'API Key 无效或已超出配额 (403)';
    if (e.status === 404) return '接口不存在或该商品不在开放平台目录中 (404)';
    if (e.status === 400) return `查询条件被拒绝 (400): ${String(e.body || '').slice(0, 200)}`;
    if (e.status === 429) return '触发限速 (429)，稍后自动重试';
  }
  return e.message;
}

/* ------------------------------------------------------------------ */
/* 底层请求                                                             */
/* ------------------------------------------------------------------ */
async function apiGet(pathWithFilters, params, apiKey, opts = {}) {
  const key = requireKey(apiKey);
  const qs = new URLSearchParams({ ...params, apiKey: key, format: 'json' });
  const url = `${API_BASE}${pathWithFilters}?${qs.toString()}`;
  try {
    return await httpJson(url, {
      timeout: opts.timeout || 20000,
      retries: 2,
      headers: { Accept: 'application/json', 'User-Agent': 'bestbuy-price-tracker/1.0' },
    });
  } catch (e) {
    e.friendly = describeApiError(e);
    // 不要把 key 泄漏进日志/UI
    if (e.url) e.url = e.url.replace(/apiKey=[^&]+/, 'apiKey=***');
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 规格化                                                              */
/* ------------------------------------------------------------------ */
export function normalizeProduct(p, extra = {}) {
  const sale = money(p.salePrice);
  const regular = money(p.regularPrice);
  const pct =
    num(p.percentSavings) ??
    (sale !== null && regular ? Math.round(((regular - sale) / regular) * 1000) / 10 : null);
  const base = {
    sku: String(p.sku),
    name: p.name || `SKU ${p.sku}`,
    image: p.image || p.thumbnailImage || null,
    url: p.url || `https://www.bestbuy.com/site/-/${p.sku}.p?skuId=${p.sku}`,
    addToCartUrl: p.addToCartUrl || null,
    manufacturer: p.manufacturer || null,
    modelNumber: p.modelNumber || null,
    condition: p.condition || 'New',
    category: Array.isArray(p.categoryPath) ? p.categoryPath.map((c) => c.name).slice(1).join(' › ') : null,
    price: sale,
    regularPrice: regular,
    onSale: !!p.onSale,
    percentOff: pct,
    dollarSavings: money(p.dollarSavings),
    rating: num(p.customerReviewAverage),
    reviews: num(p.customerReviewCount),
    inStock: p.orderable ? p.orderable !== 'SoldOut' : p.onlineAvailability !== false,
    source: 'api',
    details: Array.isArray(p.details) ? p.details : [],
    ...extra,
  };
  base.specs = extractSpecs(base);
  delete base.details; // 解析完就丢，别把上百条 detail 写进历史文件
  return base;
}

/* ------------------------------------------------------------------ */
/* 按 SKU 批量取价（关注列表刷新用的主力接口）                            */
/* ------------------------------------------------------------------ */
export async function getProductsBySkus(skus, apiKey, limiter) {
  const list = [...new Set(skus.map(String))];
  const out = new Map();
  const CHUNK = 25;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const filter = `(sku in(${chunk.join(',')}))`;
    const call = () =>
      apiGet(`/v1/products${filter}`, { show: PRODUCT_SHOW, pageSize: String(CHUNK) }, apiKey);
    const json = limiter ? await limiter(call) : await call();
    for (const p of json.products || []) {
      out.set(String(p.sku), normalizeProduct(p));
    }
  }
  return out;
}

export async function getProductBySku(sku, apiKey, limiter) {
  const map = await getProductsBySkus([sku], apiKey, limiter);
  return map.get(String(sku)) || null;
}

/* ------------------------------------------------------------------ */
/* 条件搜索（自动搜索 & "发现"页用）                                     */
/* ------------------------------------------------------------------ */
function buildFilters(q) {
  const filters = [];
  const optional = [];   // 遇到 400 时优先丢弃的条件

  if (q.categoryId) filters.push({ expr: `categoryPath.id=${q.categoryId}`, key: 'categoryId' });

  for (const word of String(q.keywords || '').trim().split(/\s+/).filter(Boolean)) {
    filters.push({ expr: `search=${encodeURIComponent(word)}`, key: 'keywords' });
  }

  if (q.onSaleOnly) filters.push({ expr: 'onSale=true', key: 'onSaleOnly' });

  const min = num(q.minPrice);
  const max = num(q.maxPrice);
  if (min !== null) filters.push({ expr: `salePrice>=${min}`, key: 'minPrice' });
  if (max !== null) filters.push({ expr: `salePrice<=${max}`, key: 'maxPrice' });

  const pct = num(q.minPercentOff);
  if (pct) {
    filters.push({ expr: `percentSavings>=${pct}`, key: 'minPercentOff' });
    optional.push('minPercentOff');
  }

  const cond = CONDITION_FILTER[q.condition];
  if (cond) {
    filters.push({ expr: `condition=${encodeURIComponent(cond)}`, key: 'condition' });
    optional.push('condition');
  }

  return { filters, optional };
}

const SORT_WHITELIST = new Set([
  'percentSavings.desc',
  'dollarSavings.desc',
  'salePrice.asc',
  'salePrice.desc',
  'name.asc',
  'customerReviewAverage.desc',
]);

/**
 * @returns {{products: Array, total: number, droppedFilters: string[], appliedClientSide: string[]}}
 */
export async function searchProducts(q, apiKey, limiter) {
  const { filters, optional } = buildFilters(q);
  const limit = Math.min(num(q.limit) || 40, 100);
  const sort = SORT_WHITELIST.has(q.sort) ? q.sort : 'percentSavings.desc';

  let active = filters;
  const dropped = [];

  for (let attempt = 0; attempt < optional.length + 1; attempt++) {
    const expr = active.map((f) => f.expr).join('&');
    const pathWithFilters = `/v1/products${expr ? `(${expr})` : ''}`;
    try {
      const call = () =>
        apiGet(
          pathWithFilters,
          { show: PRODUCT_SHOW, pageSize: String(limit), page: '1', sort },
          apiKey
        );
      const json = limiter ? await limiter(call) : await call();
      let products = (json.products || []).map((p) => normalizeProduct(p));

      // 被服务端拒绝的条件，在本地补上，保证结果仍然符合用户设定
      const clientSide = [];
      for (const key of dropped) {
        if (key === 'condition') {
          const want = CONDITION_FILTER[q.condition];
          products = products.filter((p) => (p.condition || 'New') === want);
          clientSide.push('condition');
        }
        if (key === 'minPercentOff') {
          const pct = num(q.minPercentOff) || 0;
          products = products.filter((p) => (p.percentOff ?? 0) >= pct);
          clientSide.push('minPercentOff');
        }
      }

      return {
        products,
        total: json.total ?? products.length,
        droppedFilters: dropped,
        appliedClientSide: clientSide,
      };
    } catch (e) {
      const isBadFilter = e instanceof HttpError && e.status === 400;
      const next = optional[attempt];
      if (isBadFilter && next && active.some((f) => f.key === next)) {
        log.warn(`API 拒绝过滤条件「${next}」，改为本地过滤后重试`);
        dropped.push(next);
        active = active.filter((f) => f.key !== next);
        continue;
      }
      throw e;
    }
  }
  throw new HttpError('所有过滤条件都被拒绝', { code: 'FILTERS_REJECTED' });
}

/* ------------------------------------------------------------------ */
/* 分类查找：让用户自己查实时的 category id，而不是猜                     */
/* ------------------------------------------------------------------ */
export async function searchCategories(term, apiKey, limiter) {
  const safe = String(term || '').trim().replace(/[()&=]/g, '');
  if (!safe) return [];
  const call = () =>
    apiGet(
      `/v1/categories(name=*${encodeURIComponent(safe)}*)`,
      { show: 'id,name,path.name', pageSize: '30' },
      apiKey
    );
  const json = limiter ? await limiter(call) : await call();
  return (json.categories || []).map((c) => ({
    id: c.id,
    name: c.name,
    path: Array.isArray(c.path) ? c.path.map((p) => p.name).slice(1).join(' › ') : '',
  }));
}

/* ------------------------------------------------------------------ */
/* Open Box：展示样机 / 退货重售，这是 Best Buy 上最容易捡漏的一块         */
/* ------------------------------------------------------------------ */
function normalizeOpenBoxOffer(entry, offer) {
  const prices = offer?.prices || {};
  const current = money(prices.current ?? prices.currentPrice ?? prices.regular);
  const regular = money(
    entry?.prices?.regular ?? entry?.prices?.regularPrice ?? prices.regular ?? prices.was
  );
  const pct =
    current !== null && regular ? Math.round(((regular - current) / regular) * 1000) / 10 : null;
  const condName = offer?.condition || offer?.conditionName || 'Open-Box';
  const sku = String(entry?.sku ?? offer?.sku ?? '');
  return {
    sku,
    name: entry?.names?.title || entry?.name || `SKU ${sku}`,
    image: entry?.images?.standard || entry?.image || null,
    url:
      offer?.links?.web ||
      entry?.links?.web ||
      (sku ? `https://www.bestbuy.com/site/-/${sku}.p?skuId=${sku}` : null),
    addToCartUrl: offer?.links?.addToCart || null,
    manufacturer: entry?.manufacturer || null,
    modelNumber: entry?.modelNumber || null,
    condition: `Open-Box (${condName})`,
    category: entry?.categoryPath?.map?.((c) => c.name).slice(1).join(' › ') || null,
    price: current,
    regularPrice: regular,
    onSale: current !== null && regular ? current < regular : false,
    percentOff: pct,
    dollarSavings: current !== null && regular ? money(regular - current) : null,
    rating: null,
    reviews: null,
    inStock: true,
    source: 'openbox',
  };
}

function flattenOpenBox(json) {
  const results = json?.results || json?.products || [];
  const out = [];
  const push = (row) => {
    if (row.price === null) return;
    // Open Box 接口不返回 details，只能从商品名里解析规格
    row.specs = extractSpecs(row);
    out.push(row);
  };
  for (const entry of results) {
    const offers = entry?.offers || [];
    if (!offers.length) {
      push(normalizeOpenBoxOffer(entry, entry));
      continue;
    }
    for (const offer of offers) push(normalizeOpenBoxOffer(entry, offer));
  }
  return out;
}

/**
 * Open Box 接口在 Best Buy 那边挂在 /beta 下，路径历史上变过。
 * 这里按已知的几种形态依次尝试，全部失败就返回 unavailable，
 * 由调用方降级——不会拖垮整轮查询。
 */
export async function searchOpenBox(q, apiKey, limiter) {
  const key = requireKey(apiKey);
  const limit = Math.min(num(q.limit) || 40, 100);
  const candidates = [];

  if (q.sku) {
    candidates.push(`/beta/products/${encodeURIComponent(q.sku)}/openBox`);
    candidates.push(`/beta/products/openBox(sku=${encodeURIComponent(q.sku)})`);
  } else if (q.categoryId) {
    candidates.push(`/beta/products/openBox(categoryId=${encodeURIComponent(q.categoryId)})`);
    candidates.push(`/beta/products/openBox(categoryPath.id=${encodeURIComponent(q.categoryId)})`);
  } else {
    candidates.push('/beta/products/openBox');
  }

  const errors = [];
  for (const p of candidates) {
    try {
      const call = () => apiGet(p, { pageSize: String(limit) }, key);
      const json = limiter ? await limiter(call) : await call();
      let rows = flattenOpenBox(json);

      const min = num(q.minPrice);
      const max = num(q.maxPrice);
      const pct = num(q.minPercentOff) || 0;
      if (min !== null) rows = rows.filter((r) => r.price >= min);
      if (max !== null) rows = rows.filter((r) => r.price <= max);
      if (pct) rows = rows.filter((r) => (r.percentOff ?? 0) >= pct);
      if (q.keywords) {
        const words = String(q.keywords).toLowerCase().split(/\s+/).filter(Boolean);
        rows = rows.filter((r) => words.every((w) => r.name.toLowerCase().includes(w)));
      }

      rows.sort((a, b) => (b.percentOff ?? 0) - (a.percentOff ?? 0));
      return { products: rows.slice(0, limit), available: true, endpoint: p };
    } catch (e) {
      errors.push(`${p} → ${e.friendly || e.message}`);
      if (e.code === 'NO_API_KEY') throw e;
      // 403 说明 key 没有 beta 权限，再试其它路径也没意义
      if (e instanceof HttpError && e.status === 403) break;
    }
  }

  return {
    products: [],
    available: false,
    reason: errors[errors.length - 1] || '未知原因',
    tried: errors,
  };
}

/* ------------------------------------------------------------------ */
/* 连通性自检                                                           */
/* ------------------------------------------------------------------ */
export async function pingApi(apiKey) {
  const started = Date.now();
  try {
    const json = await apiGet('/v1/products(sku=6084400)', { show: 'sku,name', pageSize: '1' }, apiKey);
    return {
      ok: true,
      ms: Date.now() - started,
      detail: `已连通，返回 ${json.total ?? 0} 条`,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, detail: e.friendly || e.message, code: e.code };
  }
}

export { API_BASE };
