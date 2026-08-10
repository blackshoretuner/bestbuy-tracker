/**
 * 兜底通道：直接读商品页拿价格。
 *
 * 说明清楚利弊——Best Buy 前面挂了 Akamai，纯 fetch 命中挑战页的概率不低，
 * 所以这条通道默认关闭，只在设置里把 provider 调成 auto/scrape 时才会用，
 * 并且节流到每 2.5 秒一个请求。抓不到就明确报 BLOCKED，不做任何绕过尝试。
 */
import { HttpError, httpText, money } from '../util.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function browserHeaders() {
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
  };
}

export class BlockedError extends Error {
  constructor(detail) {
    super('被 Best Buy 的反爬拦截了（抓取模式本来就不稳，建议用官方 API）' + (detail ? `：${detail}` : ''));
    this.code = 'BLOCKED';
  }
}

function looksBlocked(html) {
  if (!html) return true;
  const head = html.slice(0, 4000).toLowerCase();
  return (
    head.includes('access denied') ||
    head.includes('reference #') ||
    head.includes('are you a robot') ||
    head.includes('/_sec/cp_challenge/') ||
    head.includes('bot detection')
  );
}

function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch { /* 忽略坏块 */ }
  }
  return out;
}

function fromJsonLd(nodes) {
  for (const node of nodes) {
    const type = node?.['@type'];
    const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
    if (!isProduct) continue;
    const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
    const price = money(offers?.price ?? offers?.lowPrice);
    if (price === null) continue;
    return {
      name: node.name || null,
      image: Array.isArray(node.image) ? node.image[0] : node.image || null,
      price,
      inStock: !offers?.availability || /InStock/i.test(String(offers.availability)),
      rating: node.aggregateRating?.ratingValue ? Number(node.aggregateRating.ratingValue) : null,
      reviews: node.aggregateRating?.reviewCount ? Number(node.aggregateRating.reviewCount) : null,
    };
  }
  return null;
}

function fromEmbeddedState(html) {
  const patterns = [
    /"currentPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/,
    /"customerPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/,
    /"priceDomain"\s*:\s*\{[^}]*?"regularPrice"\s*:\s*([0-9.]+)/,
    /itemprop=["']price["'][^>]*content=["']([0-9.]+)["']/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const price = money(m[1]);
      if (price !== null && price > 0) return { price };
    }
  }
  return null;
}

function extractRegular(html) {
  const m =
    html.match(/"regularPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/) ||
    html.match(/"wasPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/) ||
    html.match(/"listPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
  return m ? money(m[1]) : null;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return m[1]
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s*-\s*Best Buy\s*$/i, '')
    .trim();
}

export async function scrapeProduct(sku, { timeout = 25000 } = {}) {
  const url = `https://www.bestbuy.com/site/-/${sku}.p?skuId=${sku}`;
  let body;
  try {
    ({ body } = await httpText(url, { headers: browserHeaders(), timeout, retries: 1 }));
  } catch (e) {
    if (e instanceof HttpError && (e.status === 403 || e.status === 429)) {
      throw new BlockedError(`HTTP ${e.status}`);
    }
    throw e;
  }

  if (looksBlocked(body)) throw new BlockedError('返回的是挑战页');

  const ld = fromJsonLd(extractJsonLd(body));
  const embedded = fromEmbeddedState(body);
  const price = ld?.price ?? embedded?.price ?? null;

  if (price === null) {
    throw new HttpError('页面里没找到价格（Best Buy 可能改版了）', { url, code: 'NO_PRICE' });
  }

  const regular = extractRegular(body);
  const pct =
    regular && regular > price ? Math.round(((regular - price) / regular) * 1000) / 10 : null;

  return {
    sku: String(sku),
    name: ld?.name || extractTitle(body) || `SKU ${sku}`,
    image: ld?.image || null,
    url,
    addToCartUrl: null,
    manufacturer: null,
    modelNumber: null,
    condition: 'New',
    category: null,
    price,
    regularPrice: regular,
    onSale: !!(regular && regular > price),
    percentOff: pct,
    dollarSavings: regular && regular > price ? money(regular - price) : null,
    rating: ld?.rating ?? null,
    reviews: ld?.reviews ?? null,
    inStock: ld?.inStock ?? true,
    source: 'scrape',
  };
}

export async function pingScrape() {
  const started = Date.now();
  try {
    const p = await scrapeProduct('6084400', { timeout: 20000 });
    return { ok: true, ms: Date.now() - started, detail: `可用，示例价 $${p.price}` };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, detail: e.message, code: e.code };
  }
}
