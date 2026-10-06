/**
 * 极简 Chrome DevTools Protocol 驱动 —— 零 npm 依赖。
 *
 * 用你本机已经装好的 Edge/Chrome，通过 --remote-debugging-port 起一个后台实例，
 * 用 Node 24 自带的全局 WebSocket 连上去下命令。
 * 不需要 Playwright/Puppeteer，不用下 300MB 的浏览器。
 *
 * 只实现够用的部分：开标签页、导航、等加载、在页面里执行 JS、关掉。
 */
import { execFile, spawn } from 'node:child_process';
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
/* 启动与回收的辅助                                                     */
/* ------------------------------------------------------------------ */

// 本进程手里正在用的浏览器（按 DevTools 地址）。认领"转交出去的浏览器"时排除自己人。
const liveBrowsers = new Set();
// 本进程正在用的 profile 目录。回收孤儿时跳过：转交出去的浏览器父进程早就退了，
// 光看「父进程还在不在」会把自己正在用的那个也当成孤儿
const liveProfiles = new Set();

// 同一个 profile 目录的启动排队。两次启动挤在同一秒里时，后一个可能把前一个刚起的
// 浏览器当成"自己转交出去的"认领走，用完还把它关了 —— 排个队就不会。
const launchQueue = new Map();
function serialize(key, fn) {
  const run = (launchQueue.get(key) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  launchQueue.set(key, tail);
  tail.then(() => { if (launchQueue.get(key) === tail) launchQueue.delete(key); });
  return run;
}

/** 读 <profile>/DevToolsActivePort（Chromium 开了远程调试就会写）→ ws 地址 */
function readDevToolsPort(dir) {
  try {
    const [port, p] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
    if (!/^\d+$/.test(port) || !p?.startsWith('/devtools/browser/')) return null;
    return `ws://127.0.0.1:${port}${p.trim()}`;
  } catch {
    return null;
  }
}

/**
 * 等浏览器真正放开这个 profile。判据和 #clearStaleLock 一样：Windows 上被进程
 * 打开着的文件删不掉，所以 lockfile 删得掉（或者本来就没有）= 没人在用了。
 */
async function waitForRelease(dir, ms) {
  const lock = path.join(dir, 'lockfile');
  const deadline = Date.now() + ms;
  for (;;) {
    try { fs.unlinkSync(lock); return true; } catch (e) { if (e.code === 'ENOENT') return true; }
    if (Date.now() >= deadline) return false;
    await sleep(150);
  }
}

/**
 * 最后一招：按命令行里**完全一致**的 --user-data-dir 找出还占着这个 profile 的
 * Edge/Chrome 进程，直接结束。只在体面的办法（CDP Browser.close、结束我们手里的 PID、
 * 照 DevToolsActivePort 重新接上去关）都不灵时才用 —— 比如电脑睡了一觉，连接断了、
 * 真浏览器又不是我们手里那个 PID。
 * 目录名是我们自己起的（bbt-browser-profile…），不会误伤你自己开的浏览器；
 * 要求路径后面紧跟引号/空格/结尾，免得 bbt-browser-profile 误中 bbt-browser-profile-fast。
 * @returns 结束了几个进程
 */
export function killByProfile(dir) {
  if (process.platform !== 'win32' || !/bbt-browser-profile/.test(path.basename(dir))) return Promise.resolve(0);
  const esc = (s) => s.replace(/'/g, "''");
  // 多扫几遍：Edge 刚起来时还在不停地派生子进程，一次快照之后冒出来的会漏掉
  const ps =
    `$re = '--user-data-dir="?' + [regex]::Escape('${esc(dir)}') + '"?(\\s|$)'; $seen = @{}; ` +
    `for ($i = 0; $i -lt 3; $i++) { ` +
    `$p = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | ` +
    `Where-Object { $_.CommandLine -and $_.CommandLine -match $re -and -not $seen.ContainsKey($_.ProcessId) }); ` +
    `if (-not $p.Count) { break }; ` +
    `foreach ($x in $p) { $seen[$x.ProcessId] = 1; Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }; ` +
    `Start-Sleep -Milliseconds 400 }; $seen.Count`;
  // 和 notify.js 一样走 -EncodedCommand：脚本里有引号，拼进命令行容易坏
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 20000 },
      (err, stdout) => resolve(err ? 0 : Number(String(stdout).trim()) || 0));
  });
}

/**
 * 固定 profile（共享的 / 各零售商的 / 快速盯梢的）被**已经不在了的进程**留下的浏览器占着：
 * 服务被外力结束、或者旧版本睡醒后没收拾干净，都会这样。不清掉的话，新进程每次都只能
 * 退到一次性目录（cookie 白留了），孤儿还一直耗内存。
 * 只结束「父进程已经不在了」的那种 —— 父进程还活着，可能是另一份拷贝正在用，不碰。
 * @returns 结束了几个进程
 */
function killFixedOrphans(dirs) {
  if (process.platform !== 'win32' || !dirs.length) return Promise.resolve(0);
  const list = dirs.map((d) => `'${d.replace(/'/g, "''")}'`).join(',');
  // 先认孤儿（主进程的父进程不在了），认准了再把这个 profile 上的进程多扫几遍结束（同 killByProfile）
  const ps =
    `$q = { @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'") }; $all = & $q; $seen = @{}; ` +
    `foreach ($d in @(${list})) { ` +
    `$re = '--user-data-dir="?' + [regex]::Escape($d) + '"?(\\s|$)'; ` +
    `$mine = @($all | Where-Object { $_.CommandLine -and $_.CommandLine -match $re }); ` +
    `$orphan = @($mine | Where-Object { $_.CommandLine -notmatch '--type=' -and -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) }); ` +
    `if (-not $orphan.Count) { continue }; ` +
    `for ($i = 0; $i -lt 3; $i++) { ` +
    `$p = @(& $q | Where-Object { $_.CommandLine -and $_.CommandLine -match $re -and -not $seen.ContainsKey($_.ProcessId) }); ` +
    `if (-not $p.Count) { break }; ` +
    `foreach ($x in $p) { $seen[$x.ProcessId] = 1; Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }; ` +
    `Start-Sleep -Milliseconds 400 } }; $seen.Count`;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 20000 },
      (err, stdout) => resolve(err ? 0 : Number(String(stdout).trim()) || 0));
  });
}

/** 体面地放开 profile；不行就照端口文件接上去关；再不行按 profile 结束进程。返回是否放开了 */
export async function forceRelease(dir) {
  if (await waitForRelease(dir, 5000)) return true;
  if ((await closeOrphan(dir)) && (await waitForRelease(dir, 3000))) return true;
  const n = await killByProfile(dir);
  if (n) log.warn(`浏览器退不干净，按 profile 结束了 ${n} 个残留进程：${path.basename(dir)}`);
  return waitForRelease(dir, 3000);
}

/** 删目录。浏览器刚退时文件句柄还没放完，重试一会儿；异步删，不卡事件循环 */
async function removeDir(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return true;
  } catch {
    return false;
  }
}

// 一次性目录的名字：<共享目录名>-<pid>-<创建时间，36 进制>（见 launch() 第 3 步）
const ONE_TIME_RE = /^bbt-browser-profile(?:-[a-z]+)?-(\d+)-([a-z0-9]+)$/;
// 固定 profile：bbt-browser-profile / -bh / -amazon / -fast
const FIXED_RE = /^bbt-browser-profile(?:-[a-z]+)?$/;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
let lastSweepAt = 0;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** 目录里要是还开着没人管的浏览器，接上去让它自己退出。返回是否真关掉了一个 */
async function closeOrphan(dir) {
  const url = readDevToolsPort(dir);
  if (!url || liveBrowsers.has(url)) return false;
  let ws;
  try { ws = await connectWs(url, 1500); } catch { return false; }   // 没人听 = 浏览器早不在了
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 2000);
    ws.addEventListener('close', () => { clearTimeout(t); resolve(); }, { once: true });
    try { ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); } catch { clearTimeout(t); resolve(); }
  });
  try { ws.close(); } catch { /* ignore */ }
  await waitForRelease(dir, 5000);
  return true;
}

/**
 * 回收残留的一次性 profile 目录：里面还开着浏览器的先让它体面退出，再删目录。
 *
 * 只动名字符合一次性格式的 —— 共享 profile 留着 cookie，永远不碰。
 * 可能还在用的跳过：本进程建的且不到 1 小时；别的活着的进程建的且不到 12 小时
 * （同一台机器上可能跑着另一份拷贝）。一轮查询远用不了这么久。
 */
export async function sweepStaleProfiles({ baseDir = os.tmpdir(), now = Date.now() } = {}) {
  const out = { removed: 0, closed: 0, failed: 0 };
  let names = [];
  try { names = fs.readdirSync(baseDir); } catch { return out; }
  for (const name of names) {
    const m = name.match(ONE_TIME_RE);
    if (!m) continue;
    const pid = Number(m[1]);
    const age = now - parseInt(m[2], 36);
    if (pid === process.pid ? age < 3600e3 : pidAlive(pid) && age < 12 * 3600e3) continue;
    const dir = path.join(baseDir, name);
    if (await closeOrphan(dir)) out.closed++;
    if (await removeDir(dir)) { out.removed++; continue; }
    // 还被占着又接不上：一次性目录的主人已经不在了，里面的浏览器肯定是孤儿
    if ((await killByProfile(dir)) > 0) out.closed++;
    if (await removeDir(dir)) out.removed++;
    else out.failed++;
  }

  // 固定 profile 上的孤儿（目录留着，只结束进程）。本进程正在用的跳过
  const fixed = names
    .filter((n) => FIXED_RE.test(n))
    .map((n) => path.join(baseDir, n))
    .filter((d) => !liveProfiles.has(d));
  const killed = await killFixedOrphans(fixed);
  if (killed) out.orphans = killed;
  return out;
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
  #closing = false;

  constructor(proc, ws, info) {
    this.#proc = proc;
    this.#ws = ws;
    this.info = info;
  }

  /** 连接已经断了（关过、或者电脑睡醒后断开）。会话据此决定要不要重开一个 */
  get closed() {
    return this.#closed;
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

    // 顺手回收以前留下的一次性目录。每小时最多一次，后台跑，不耽误这次启动
    if (Date.now() - lastSweepAt > SWEEP_EVERY_MS) {
      lastSweepAt = Date.now();
      sweepStaleProfiles()
        .then((r) => {
          const bits = [];
          if (r.orphans) bits.push(`结束 ${r.orphans} 个上次留下的孤儿浏览器进程`);
          if (r.closed) bits.push(`关掉 ${r.closed} 个没人管的浏览器`);
          if (r.removed) bits.push(`删掉 ${r.removed} 个残留的一次性 profile 目录`);
          if (r.failed) bits.push(`${r.failed} 个还被占着删不掉，下次再试`);
          if (bits.length) log.info('回收：' + bits.join('，'));
        })
        .catch(() => { /* 下次再说 */ });
    }

    // 同一个 user-data-dir 被两个浏览器实例同时用 → Edge/Chrome 直接退出（code 21）。
    // 定时轮次正在跑的时候，界面上点「立即运行」/「测浏览器」、或者调 /api/preview
    // 就会撞上；轮次越长撞得越勤。
    // 第一次仍用共享 profile（cookie 留着，挑战页少一些），撞锁了就换个独占目录重来。
    return serialize(profileDir, async () => {
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
        await removeDir(tempDir);
        throw e;
      }
    });
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

    // 旧的端口文件先删掉：这样之后这里再出现的，一定是这次启动的浏览器写的（见 onExit）。
    // 删不掉就不信它，转交出去的浏览器也不去认领
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    let portFileFresh = true;
    try { fs.unlinkSync(portFile); } catch (e) { portFileFresh = e.code === 'ENOENT'; }
    const startedAt = Date.now();

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

    let detached = false;
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        fn(value);
      };
      const timer = setTimeout(() => {
        try { proc.kill(); } catch { /* ignore */ }
        finish(reject, new BrowserError(`浏览器启动超时（${timeout}ms）`, 'LAUNCH_TIMEOUT'));
      }, timeout);

      const onData = (chunk) => {
        buf += chunk.toString();
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) finish(resolve, m[1].trim());
      };
      const onExit = async (code) => {
        cleanup();
        // Edge 有时会把自己"转交"给另一个进程：我们起的这个以 code 0 退出，真浏览器是
        // 另一个进程（父进程不是我们），stderr 也不在我们的管道上。2026-09-24~25 那一版
        // Edge 一直这样（多半是有更新在排队）。以前这里直接判失败，那个真浏览器就没人管了
        // —— 无头开着一跑十几个小时，每轮 3 个，一天攒了 40 多个、11 GB。
        // 它照样会把调试端口写进 DevToolsActivePort，读这个文件接上它就能正常用、正常关。
        if (code === 0 && portFileFresh) {
          const deadline = Math.min(Date.now() + 8000, startedAt + timeout);
          while (!settled && Date.now() < deadline) {
            const url = readDevToolsPort(profileDir);
            if (url && !liveBrowsers.has(url)) {
              detached = true;
              return finish(resolve, url);
            }
            await sleep(200);
          }
        }
        finish(reject, new BrowserError(`浏览器进程退出（code ${code}）：${buf.slice(-300)}`, 'LAUNCH_FAILED'));
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

    let ws;
    try {
      ws = await connectWs(wsUrl, timeout);
    } catch (e) {
      // 浏览器起来了却连不上：**别把它留在那儿** —— 以前这里直接抛错，进程就成了孤儿
      //（2026-10-06 电脑睡醒后实测漏下一个）。转交出去的那个不是 proc，按 profile 收拾
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      await forceRelease(profileDir);
      // 认领到了却连不上：按启动失败算，让 launch() 接着走回退
      if (detached) throw new BrowserError(`浏览器转交给了另一个进程，但连不上它：${e.message}`, 'LAUNCH_FAILED');
      throw e;
    }
    const browser = new Browser(proc, ws, { ...found, headless, detached });
    browser.profileDir = profileDir;
    browser.wsUrl = wsUrl;
    liveBrowsers.add(wsUrl);
    liveProfiles.add(profileDir);
    browser.#attach();
    log.info(`浏览器已启动：${found.name}${headless ? '（无头）' : '（窗口移到屏幕外）'}${detached ? '，Edge 把自己转交给了另一个进程，已接上' : ''}`);
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
      liveBrowsers.delete(this.wsUrl);
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
    if (this.#closing) return;   // 会话收摊和别处可能各调一次，只收一遍
    this.#closing = true;
    // 连接还在：先走 CDP 让浏览器**自己**退出 —— 它会正常释放 profile 锁。
    // 以前是 proc.kill()（Windows 上就是 TerminateProcess 强杀）+ 等 150ms，
    // Edge 根本来不及收尾，每次都在共享 profile 里留下残锁，下一次启动必撞，
    // 然后回退到一次性目录……这是 143 个 / 10.4 GB 临时目录的源头。
    // 连接已经断了（电脑睡了一觉醒来就是这样）也**不能就此撒手**：进程多半还活着。
    // 以前这里一看连接断了就直接 return，睡一觉就漏下好几个无头 Edge（2026-10-06 实测 5 个）。
    if (!this.#closed) {
      try { await this.send('Browser.close', {}, undefined, 2000); } catch { /* 下面接着收拾 */ }
    }
    this.#closed = true;
    liveBrowsers.delete(this.wsUrl);
    try { this.#ws.close(); } catch { /* ignore */ }

    // 等它真的退出，最多 3 秒；超时才强杀。转交出去的那种 #proc 早就退了，这步直接跳过
    const deadline = Date.now() + 3000;
    while (this.#proc.exitCode === null && Date.now() < deadline) await sleep(100);
    if (this.#proc.exitCode === null) {
      try { this.#proc.kill('SIGKILL'); } catch { /* ignore */ }
    }

    // 真正的浏览器进程不一定是 #proc（Edge 会转交），所以以 profile 锁为准：放开了才算退干净。
    // 放不开就照端口文件重新接上去关，再不行按 profile 结束进程（见 forceRelease）。
    // 和启动走同一个队列：收拾的时候不会有新浏览器正在同一个 profile 上起来，免得误伤它
    const dir = this.profileDir;
    if (dir && !(await serialize(dir, () => forceRelease(dir)))) {
      log.warn(`浏览器没能完全退出，profile 仍被占用：${path.basename(dir)}`);
    }
    if (dir) liveProfiles.delete(dir);

    // 一次性目录用完即删（删不掉的，下次 sweepStaleProfiles 兜底）
    if (this.tempProfile) await removeDir(this.tempProfile);
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
