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

    // 同一个 user-data-dir 被两个浏览器实例同时用 → Edge/Chrome 直接退出（code 21）。
    // 定时轮次正在跑的时候，界面上点「立即运行」/「测浏览器」、或者调 /api/preview
    // 就会撞上；轮次越长撞得越勤。
    // 第一次仍用共享 profile（cookie 留着，挑战页少一些），撞锁了就换个独占目录重来。
    // 1) 共享 profile（留着 cookie，挑战页少一些）
    try {
      return await Browser.#spawnAndConnect(found, { profileDir, headless, width, height, timeout });
    } catch (e) {
      if (e.code !== 'LAUNCH_FAILED') throw e;   // 超时、找不到浏览器之类别瞎重试
    }

    // 2) 起不来多半是上次被强杀留下的残锁。Windows 上**被进程打开着的文件删不掉**，
    //    所以"能删掉 = 没人在用 = 残锁"，删了原地再试一次，不必另开目录。
    if (Browser.#clearStaleLock(profileDir)) {
      log.info('清掉了共享 profile 的残留锁，重试');
      try {
        return await Browser.#spawnAndConnect(found, { profileDir, headless, width, height, timeout });
      } catch (e) {
        if (e.code !== 'LAUNCH_FAILED') throw e;
      }
    }

    // 3) 真被别的实例占着（比如界面上手动运行 + 定时轮次同时开）→ 用一次性的独占目录，
    //    **关浏览器时删掉**。以前不删，每次回退都在 %TEMP% 留一个，实测攒了 143 个、10.4 GB。
    const tempDir = `${profileDir}-${process.pid}-${Date.now().toString(36)}`;
    log.warn('共享 profile 正被另一个实例使用，改用一次性独占目录（用完即删）');
    try {
      const b = await Browser.#spawnAndConnect(found, { profileDir: tempDir, headless, width, height, timeout });
      b.tempProfile = tempDir;
      return b;
    } catch (e) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw e;
    }
  }

  static #clearStaleLock(dir) {
    const lock = path.join(dir, 'lockfile');
    if (!fs.existsSync(lock)) return false;
    try {
      fs.unlinkSync(lock);
      return true;
    } catch {
      return false;   // 删不掉 = 真有进程在用
    }
  }

  static async #spawnAndConnect(found, { profileDir, headless, width, height, timeout }) {
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
    // 先走 CDP 让浏览器**自己**退出 —— 它会正常释放 profile 锁。
    // 以前是 proc.kill()（Windows 上就是 TerminateProcess 强杀）+ 等 150ms，
    // Edge 根本来不及收尾，每次都在共享 profile 里留下残锁，下一次启动必撞，
    // 然后回退到一次性目录……这是 143 个 / 10.4 GB 临时目录的源头。
    try { await this.send('Browser.close', {}, undefined, 2000); } catch { /* 已经断了就算了 */ }
    this.#closed = true;
    try { this.#ws.close(); } catch { /* ignore */ }

    // 等它真的退出，最多 3 秒；超时才强杀
    const deadline = Date.now() + 3000;
    while (this.#proc.exitCode === null && Date.now() < deadline) await sleep(100);
    if (this.#proc.exitCode === null) {
      try { this.#proc.kill('SIGKILL'); } catch { /* ignore */ }
    }

    // 一次性目录用完即删
    if (this.tempProfile) {
      await sleep(300);   // 进程退了文件句柄还要一会儿才放
      try { fs.rmSync(this.tempProfile, { recursive: true, force: true }); } catch { /* 下次清理兜底 */ }
    }
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

  /**
   * 分段滚到底，触发懒加载；直到计数不再增长。
   *
   * 2026-08-11 实测结论，别再往这上面花时间：
   * **Best Buy 的搜索页不是靠滚动加载商品的。** 强制滚到绝对底部（40 轮 × 1s）、
   * 到底后再等 4 秒，商品数纹丝不动；页面上那个「Show more」按钮点两次也不涨。
   * 一页给多少就是多少（无头 ~8-10 个，真实窗口 ~12-16 个）。
   * 要拿更多只能翻页（URL 的 cp= 参数），见 settings.maxPagesPerSearch。
   *
   * 所以这里保持轻量即可 —— 留着是为了兜底（万一哪天改回懒加载），
   * 不值得为它多等。计数连续不变就早退。
   */
  async scrollToLoadAll({ maxRounds = 10, stepPause = 500, countExpr } = {}) {
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
