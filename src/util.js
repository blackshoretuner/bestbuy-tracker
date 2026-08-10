import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function uid(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function money(v) {
  const n = num(v);
  return n === null ? null : Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* 日志：控制台 + 内存环形缓冲，UI 的"诊断"页读这个                       */
/* ------------------------------------------------------------------ */
const LOG_CAP = 600;
const logBuffer = [];
const logListeners = new Set();

export function log(level, msg, extra) {
  const line = {
    ts: Date.now(),
    level,
    msg: String(msg),
    extra: extra === undefined ? undefined : safeJson(extra),
  };
  logBuffer.push(line);
  if (logBuffer.length > LOG_CAP) logBuffer.splice(0, logBuffer.length - LOG_CAP);
  const stamp = new Date(line.ts).toLocaleTimeString();
  const tag = level.toUpperCase().padEnd(5);
  // eslint-disable-next-line no-console
  console.log(`[${stamp}] ${tag} ${line.msg}${line.extra ? ' ' + line.extra : ''}`);
  for (const fn of logListeners) {
    try { fn(line); } catch { /* ignore */ }
  }
  return line;
}

log.info = (m, e) => log('info', m, e);
log.warn = (m, e) => log('warn', m, e);
log.error = (m, e) => log('error', m, e);
log.debug = (m, e) => log('debug', m, e);

export function getLogs(limit = 300) {
  return logBuffer.slice(-limit);
}

export function onLog(fn) {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}

function safeJson(v) {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 500 ? s.slice(0, 500) + '…' : s;
  } catch {
    return String(v);
  }
}

/* ------------------------------------------------------------------ */
/* 限速器：把所有出站请求串起来，保证两次之间至少间隔 minIntervalMs        */
/* ------------------------------------------------------------------ */
export function createLimiter(minIntervalMs) {
  let last = 0;
  let tail = Promise.resolve();
  const limiter = (fn) => {
    const run = async () => {
      const wait = last + limiter.minInterval - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return fn();
    };
    const result = tail.then(run, run);
    tail = result.then(() => {}, () => {});
    return result;
  };
  limiter.minInterval = minIntervalMs;
  return limiter;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */
export class HttpError extends Error {
  constructor(message, { status, body, url, code } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status ?? 0;
    this.body = body;
    this.url = url;
    this.code = code || 'HTTP_ERROR';
  }
}

export async function httpText(url, options = {}) {
  const {
    headers = {},
    timeout = 20000,
    retries = 2,
    retryOn = [429, 500, 502, 503, 504],
    method = 'GET',
  } = options;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { method, headers, signal: ctl.signal, redirect: 'follow' });
      const body = await res.text();
      if (!res.ok) {
        const err = new HttpError(`HTTP ${res.status} ${res.statusText}`, {
          status: res.status,
          body: body.slice(0, 800),
          url,
          code: res.status === 403 ? 'FORBIDDEN' : 'HTTP_ERROR',
        });
        if (retryOn.includes(res.status) && attempt < retries) {
          await sleep(800 * Math.pow(2, attempt) + Math.random() * 400);
          lastErr = err;
          continue;
        }
        throw err;
      }
      return { body, res };
    } catch (e) {
      lastErr = e;
      const transient =
        e.name === 'AbortError' ||
        e.code === 'ECONNRESET' ||
        e.cause?.code === 'ECONNRESET' ||
        e.cause?.code === 'ETIMEDOUT' ||
        e.cause?.code === 'ENOTFOUND' ||
        e.cause?.code === 'EAI_AGAIN';
      if (transient && attempt < retries) {
        await sleep(800 * Math.pow(2, attempt) + Math.random() * 400);
        continue;
      }
      if (e instanceof HttpError) throw e;
      throw new HttpError(e.name === 'AbortError' ? `请求超时 (${timeout}ms)` : e.message, {
        url,
        code: e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK',
      });
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function httpJson(url, options = {}) {
  const { body } = await httpText(url, options);
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError('返回的不是合法 JSON', { url, body: body.slice(0, 400), code: 'BAD_JSON' });
  }
}

/* ------------------------------------------------------------------ */
/* 其它小工具                                                           */
/* ------------------------------------------------------------------ */
export function parseSkuFromInput(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d{6,9}$/.test(s)) return s;
  const m =
    s.match(/[?&]skuId=(\d{6,9})/i) ||
    s.match(/\/(\d{6,9})\.p(?:\?|$|#)/i) ||
    s.match(/(\d{7,9})/);
  return m ? m[1] : null;
}

export function inQuietHours(quiet, date = new Date()) {
  if (!quiet?.enabled) return false;
  const toMin = (hhmm) => {
    const [h, m] = String(hhmm || '0:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const cur = date.getHours() * 60 + date.getMinutes();
  const s = toMin(quiet.start);
  const e = toMin(quiet.end);
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

export function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
