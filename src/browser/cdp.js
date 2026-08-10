/**
 * 极简 Chrome DevTools Protocol 驱动 —— 零 npm 依赖。
 *
 * 用你本机已经装好的 Edge/Chrome，通过 --remote-debugging-port 起一个后台实例，
 * 用 Node 24 自带的全局 WebSocket 连上去下命令。
 * 不需要 Playwright/Puppeteer，不用下 300MB 的浏览器。
 *
 * 只实现够用的部分：开标签页、导航、等加载、在页面里执行 JS、关掉。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log, sleep } from '../util.js';

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
];

export function findBrowser(preferred) {
  if (preferred && fs.existsSync(preferred)) return { path: preferred, name: 'custom' };
  for (const p of EDGE_PATHS) if (fs.existsSync(p)) return { path: p, name: 'Edge' };
  for (const p of CHROME_PATHS) if (fs.existsSync(p)) return { path: p, name: 'Chrome' };
  return null;
}

export class BrowserError extends Error {
  constructor(message, code = 'BROWSER_ERROR') {
    super(message);
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Browser                                                             */
/* ------------------------------------------------------------------ */
export class Browser {
  #ws = null;
  #nextId = 1;
  #pending = new Map();
  #sessionListeners = new Map();
  #proc = null;
  #closed = false;

  constructor(proc, ws, info) {
    this.#proc = proc;
    this.#ws = ws;
    this.info = info;
  }

  static async launch(opts = {}) {
    const {
      exePath,
      headless = true,
      width = 1600,
      height = 1200,
      timeout = 45000,
      profileDir = path.join(os.tmpdir(), 'bbt-browser-profile'),
    } = opts;

    const found = findBrowser(exePath);
    if (!found) {
      throw new BrowserError(
        '没找到 Edge 或 Chrome。Windows 11 自带 Edge，如果被卸载了请装一个 Chrome。',
        'NO_BROWSER'
      );
    }

    fs.mkdirSync(profileDir, { recursive: true });

    const args = [
      headless ? '--headless=new' : '--window-position=-32000,-32000',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-sync',
      '--disable-extensions',
      '--mute-audio',
      '--no-sandbox',
      'about:blank',
    ];

    const proc = spawn(found.path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => {
        cleanup();
        try { proc.kill(); } catch { /* ignore */ }
        reject(new BrowserError(`浏览器启动超时（${timeout}ms）`, 'LAUNCH_TIMEOUT'));
      }, timeout);

      const onData = (chunk) => {
        buf += chunk.toString();
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) {
          clearTimeout(timer);
          cleanup();
          resolve(m[1].trim());
        }
      };
      const onExit = (code) => {
        clearTimeout(timer);
        cleanup();
        reject(new BrowserError(`浏览器进程退出（code ${code}）：${buf.slice(-300)}`, 'LAUNCH_FAILED'));
      };
      function cleanup() {
        proc.stderr?.off('data', onData);
        proc.stdout?.off('data', onData);
        proc.off('exit', onExit);
      }
      proc.stderr?.on('data', onData);
      proc.stdout?.on('data', onData);
      proc.on('exit', onExit);
    });

    const ws = await connectWs(wsUrl, timeout);
    const browser = new Browser(proc, ws, { ...found, headless });
    browser.#attach();
    log.info(`浏览器已启动：${found.name}${headless ? '（无头）' : '（窗口移到屏幕外）'}`);
    return browser;
  }

  #attach() {
    this.#ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.id !== undefined && this.#pending.has(msg.id)) {
        const { resolve, reject, timer } = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new BrowserError(`${msg.error.message} (${msg.error.code})`, 'CDP_ERROR'));
        else resolve(msg.result);
        return;
      }

      if (msg.method) {
        const key = msg.sessionId || '__browser__';
        for (const fn of this.#sessionListeners.get(key) || []) {
          try { fn(msg); } catch { /* ignore */ }
        }
      }
    });

    this.#ws.addEventListener('close', () => {
      this.#closed = true;
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(new BrowserError('浏览器连接已断开', 'DISCONNECTED'));
      }
      this.#pending.clear();
    });
  }

  send(method, params = {}, sessionId, timeout = 30000) {
    if (this.#closed) return Promise.reject(new BrowserError('浏览器已关闭', 'CLOSED'));
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BrowserError(`CDP 命令超时：${method}`, 'CDP_TIMEOUT'));
      }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new BrowserError(`发送失败：${e.message}`, 'SEND_FAILED'));
      }
    });
  }

  on(sessionId, fn) {
    const key = sessionId || '__browser__';
    if (!this.#sessionListeners.has(key)) this.#sessionListeners.set(key, new Set());
    this.#sessionListeners.get(key).add(fn);
    return () => this.#sessionListeners.get(key)?.delete(fn);
  }

  async newPage(opts = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await page.init(opts);
    return page;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#ws.close(); } catch { /* ignore */ }
    try { this.#proc.kill(); } catch { /* ignore */ }
    // 给它一点时间体面退出，不然 profile 目录会留锁
    await sleep(150);
    try { if (this.#proc.exitCode === null) this.#proc.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */
export class Page {
  constructor(browser, targetId, sessionId) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  #send(method, params, timeout) {
    return this.browser.send(method, params, this.sessionId, timeout);
  }

  async init({ width = 1600, height = 1200, userAgent } = {}) {
    await this.#send('Page.enable');
    await this.#send('Runtime.enable');
    await this.#send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    if (userAgent) {
      await this.#send('Network.enable');
      await this.#send('Network.setUserAgentOverride', { userAgent });
    }
  }

  /** 导航并等 load 事件；超时不抛错，交给调用方看抓到什么 */
  async goto(url, { timeout = 45000, settleMs = 1200 } = {}) {
    const loaded = new Promise((resolve) => {
      const off = this.browser.on(this.sessionId, (msg) => {
        if (msg.method === 'Page.loadEventFired') {
          off();
          resolve(true);
        }
      });
      setTimeout(() => { off(); resolve(false); }, timeout);
    });

    await this.#send('Page.navigate', { url }, timeout);
    const ok = await loaded;
    if (settleMs) await sleep(settleMs);
    return ok;
  }

  /**
   * 在页面里执行代码。expression 应当是一个自执行表达式，
   * 返回值必须能 JSON 序列化。
   */
  async evaluate(expression, { timeout = 30000, awaitPromise = true } = {}) {
    const res = await this.#send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise, userGesture: true },
      timeout
    );
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new BrowserError(
        `页面脚本出错：${d.exception?.description || d.text || '未知'}`.slice(0, 300),
        'EVAL_ERROR'
      );
    }
    return res.result?.value;
  }

  /** 分段滚到底，触发懒加载；直到计数不再增长 */
  async scrollToLoadAll({ maxRounds = 12, stepPause = 400, countExpr } = {}) {
    let last = -1;
    let stable = 0;
    for (let i = 0; i < maxRounds; i++) {
      const atBottom = await this.evaluate(
        `(() => { const before = window.scrollY;
                  window.scrollBy(0, Math.round(window.innerHeight * 0.85));
                  return window.scrollY === before; })()`
      ).catch(() => false);
      await sleep(stepPause);
      if (!countExpr) {
        if (atBottom) break;
        continue;
      }
      const n = await this.evaluate(countExpr).catch(() => last);
      // 连续两轮数量没变就认为加载完了，不用死等到 maxRounds
      stable = n === last ? stable + 1 : 0;
      last = n;
      if (stable >= 2 || (atBottom && stable >= 1)) break;
    }
    return last;
  }

  async close() {
    try { await this.browser.send('Target.closeTarget', { targetId: this.targetId }); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
function connectWs(url, timeout) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new BrowserError('连接 DevTools 超时', 'WS_TIMEOUT'));
    }, timeout);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new BrowserError('连接 DevTools 失败', 'WS_ERROR'));
    }, { once: true });
  });
}
