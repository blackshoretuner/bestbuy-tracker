#!/usr/bin/env node
/**
 * bbt —— Best Buy 降价雷达的控制程序
 *
 *   bbt              交互菜单（双击 bbt.cmd 走这条）
 *   bbt status       看状态
 *   bbt start [端口]  启动
 *   bbt stop         停止
 *   bbt restart [端口]
 *   bbt port <端口>   改默认端口（在跑的话顺手重启）
 *   bbt open         用浏览器打开界面
 *
 * 设计要点：
 *  - 认进程靠 data/server.pid 里的 pid + 端口 + token，不靠 "杀掉所有 node.exe"
 *  - 停止走 HTTP 关机接口，让服务自己落盘再退；无响应才升级到强杀
 *  - 端口写进 settings.json，不用环境变量（PORT 残留在 shell 里坑过一次）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server.js');
// 从 config.js 拿数据目录，别自己拼 ROOT/data —— 程序目录写不进去时
// （Program Files、只读 U 盘）它会退到 %LOCALAPPDATA%，两边必须一致，
// 否则控制脚本会去错的地方找 pid 文件。
const { DATA_DIR } = await import(pathToFileURL(path.join(ROOT, 'src', 'config.js')).href);
const PID_FILE = path.join(DATA_DIR, 'server.pid');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DEFAULT_PORT = 8787;

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('90', s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const bold = (s) => c('1', s);

const say = (...a) => console.log(...a);

/** die() 抛这个；顶层认得它，就不会把它当成崩溃打一堆栈 */
class ExitSignal extends Error {}

const die = (msg, code = 1) => {
  console.error(red('✗ ') + msg);
  process.exitCode = code;
  throw new ExitSignal(msg);
};

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function savedPort() {
  const s = readJson(SETTINGS_FILE, {});
  return Number(s?.port) || DEFAULT_PORT;
}

function setSavedPort(port) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const s = readJson(SETTINGS_FILE, {}) || {};
  s.port = port;
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
}

function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** 端口有人监听吗（不管是不是我们的） */
function portBusy(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}

/** 端口上答话的是不是我们的服务 */
async function probe(port, timeout = 1500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/instance`, { signal: ctl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.app === 'bestbuy-price-tracker' ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 端口上那个实例，是不是"本目录"这一份？ */
function isOurs(info) {
  if (!info?.root) return true;            // 老版本没报 root，按老行为当自己人
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(info.root) === norm(ROOT);
}

/**
 * 找到当前实例。先信 pid 文件，再退回按已保存端口探测
 * （pid 文件可能因为强杀而残留或丢失）。
 *
 * 注意"同一个程序的另一份拷贝"：便携版会被拷到处都是，两份都用默认端口
 * 8787 的话，光看 app 名字会把别人家的实例当成自己的，然后 bbt stop
 * 就把隔壁那份停了。所以要比对安装目录，不是自己的就标成 foreign，
 * 由各个命令自己决定怎么处理。
 */
async function findInstance() {
  const rec = readJson(PID_FILE);
  if (rec?.port) {
    const info = await probe(rec.port);
    if (info && isOurs(info)) return { ...info, token: rec.token, source: 'pidfile' };
    // pid 文件在，但端口没人答话（或答话的是别人）—— 陈旧记录
    if (!isAlive(rec.pid)) {
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    }
  }
  const port = savedPort();
  const info = await probe(port);
  if (info) {
    if (isOurs(info)) return { ...info, token: rec?.token, source: 'port' };
    return { ...info, foreign: true, source: 'port' };
  }
  return null;
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} 小时 ${m % 60} 分` : `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

/* ------------------------------------------------------------------ */
/* 命令                                                                */
/* ------------------------------------------------------------------ */
/** 端口上是同程序的另一份拷贝时，统一的提示 */
function foreignNote(inst) {
  return [
    yellow(`  端口 ${inst.port} 上跑着这个程序的另一份拷贝：`),
    dim(`    ${inst.root || '(未知目录)'}  PID ${inst.pid}`),
    dim(`    要停它，去那个文件夹里执行 bbt stop；`),
    dim(`    要两份同时跑，给本份换个端口：bbt port ${inst.port + 1}`),
  ].join('\n');
}

async function cmdStatus() {
  const inst = await findInstance();
  const port = savedPort();

  if (inst?.foreign) {
    say(`${red('●')} 未运行` + dim('（本目录这一份）'));
    say(foreignNote(inst));
    return 1;
  }

  if (!inst) {
    say(`${red('●')} 未运行`);
    say(dim(`  默认端口 ${port} · ${await portBusy(port) ? yellow('注意：该端口被别的程序占着') : '端口空闲'}`));
    say(dim(`  启动：bbt start`));
    return 1;
  }

  say(`${green('●')} 运行中`);
  say(`  地址    ${bold(`http://127.0.0.1:${inst.port}`)}`);
  say(`  进程    PID ${inst.pid}`);
  say(`  已运行  ${fmtUptime(Date.now() - inst.startedAt)}`);
  say(`  定时器  ${inst.running ? green('开') : yellow('停')}`);
  if (inst.port !== port) {
    say(yellow(`  提示    当前端口 ${inst.port} 和配置里的 ${port} 不一致（多半是 bbt start ${inst.port} 临时指定的）`));
  }
  return 0;
}

async function waitFor(fn, { timeout = 25000, step = 300 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r) return r;
    await sleep(step);
  }
  return null;
}

async function cmdStart(portArg) {
  const running = await findInstance();

  if (running?.foreign && (portArg ?? savedPort()) === running.port) {
    console.error(red('✗ ') + `端口 ${running.port} 被这个程序的另一份拷贝占着`);
    say(foreignNote(running));
    process.exitCode = 1;
    return 1;
  }

  if (running) {
    say(yellow('已经在运行了') + dim(` — http://127.0.0.1:${running.port} (PID ${running.pid})`));
    say(dim('  想换端口：bbt port <端口>    想重启：bbt restart'));
    return 0;
  }

  const port = portArg ?? savedPort();
  if (await portBusy(port)) {
    die(
      `端口 ${port} 被别的程序占着。\n` +
        `  换一个：bbt start ${port + 1}\n` +
        `  或永久改：bbt port ${port + 1}\n` +
        `  想看是谁占的：netstat -ano | findstr :${port}`
    );
  }
  if (portArg) setSavedPort(port);

  say(dim(`启动中… (端口 ${port})`));

  // 明确清掉 PORT 环境变量：这玩意儿残留在 shell 里会静默劫持端口
  const env = { ...process.env };
  delete env.PORT;

  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const inst = await waitFor(() => probe(port));
  if (!inst) {
    die(`启动超时。手动跑一遍看报什么错：\n  cd "${ROOT}" && node server.js`);
  }

  say(`${green('✓')} 已启动 — ${bold(`http://127.0.0.1:${inst.port}`)} (PID ${inst.pid})`);
  return 0;
}

async function cmdStop({ quiet = false } = {}) {
  const inst = await findInstance();

  // 绝不去停别人家的实例 —— 这正是加 root 校验要防的事
  if (inst?.foreign) {
    if (!quiet) {
      say(dim('本目录这一份没在运行'));
      say(foreignNote(inst));
    }
    return 0;
  }

  if (!inst) {
    const rec = readJson(PID_FILE);
    if (rec && isAlive(rec.pid)) {
      // 端口不答话但进程还在 —— 卡死了，只能硬来
      say(yellow(`进程 ${rec.pid} 还活着但没响应，强制结束`));
      try { process.kill(rec.pid, 'SIGKILL'); } catch { /* ignore */ }
      try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
      say(`${green('✓')} 已强制结束`);
      return 0;
    }
    if (!quiet) say(dim('本来就没在运行'));
    return 0;
  }

  // 优先走关机接口，让它自己把数据落盘
  let graceful = false;
  if (inst.token) {
    try {
      const res = await fetch(`http://127.0.0.1:${inst.port}/api/shutdown`, {
        method: 'POST',
        headers: { 'x-bbt-token': inst.token },
      });
      graceful = res.ok;
    } catch {
      /* 下面兜底 */
    }
  }

  const gone = await waitFor(async () => !(await probe(inst.port, 800)) && !isAlive(inst.pid), {
    timeout: 8000,
    step: 250,
  });

  if (!gone) {
    say(yellow('优雅退出没成功，强制结束'));
    try { process.kill(inst.pid, 'SIGKILL'); } catch { /* ignore */ }
    await sleep(400);
  }

  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  say(`${green('✓')} 已停止${graceful && gone ? dim('（数据已保存）') : ''}`);
  return 0;
}

async function cmdRestart(portArg) {
  await cmdStop({ quiet: true });
  await sleep(500);
  return cmdStart(portArg);
}

async function cmdPort(portArg) {
  if (portArg == null) die('要指定端口，比如：bbt port 9000');

  const found = await findInstance();
  const inst = found?.foreign ? null : found;   // 别人家的不算"本份在跑"
  const old = savedPort();

  if (portArg !== old && (await portBusy(portArg))) {
    const who = await probe(portArg);
    if (!who || !inst || who.pid !== inst.pid) {
      const extra =
        who && !isOurs(who)
          ? `\n  占用者是这个程序的另一份拷贝：${who.root || '(未知目录)'}`
          : `\n  查是谁：netstat -ano | findstr :${portArg}`;
      die(`端口 ${portArg} 被别的程序占着，换一个吧。${extra}`);
    }
  }

  setSavedPort(portArg);
  say(`${green('✓')} 默认端口 ${dim(old)} → ${bold(portArg)}`);

  if (inst) {
    say(dim('服务正在跑，重启以生效…'));
    return cmdRestart(portArg);
  }
  say(dim('  下次 bbt start 就会用新端口'));
  return 0;
}

async function cmdOpen() {
  const found = await findInstance();
  if (found?.foreign) {
    say(yellow('本目录这一份没在运行'));
    say(foreignNote(found));
    return 1;
  }
  if (!found) {
    say(yellow('服务没在跑，先启动'));
    const code = await cmdStart();
    if (code !== 0) return code;
  }
  const port = (await findInstance())?.port ?? savedPort();
  const url = `http://127.0.0.1:${port}`;
  spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  say(`${green('✓')} 已打开 ${url}`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* 交互菜单（不带参数时进这里，双击也能用）                              */
/* ------------------------------------------------------------------ */
async function cmdMenu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // stdin 关掉（Ctrl+D、管道读完、窗口被关）时 question() 会抛
  // ERR_USE_AFTER_CLOSE。返回 null 让主循环干净退出，别甩一堆栈出来。
  const ask = async (prompt) => {
    try {
      return await rl.question(prompt);
    } catch {
      return null;
    }
  };

  rl.on('SIGINT', () => {
    say('');
    rl.close();
  });

  try {
    for (;;) {
      console.clear?.();
      say(bold('  Best Buy 降价雷达') + dim('  控制台\n'));
      const found = await findInstance();
      const inst = found?.foreign ? null : found;   // 别人家的实例不给菜单操作
      await cmdStatus();

      say('');
      if (inst) {
        say(`  ${bold('[1]')} 停止      ${bold('[2]')} 重启      ${bold('[3]')} 打开界面`);
      } else {
        say(`  ${bold('[1]')} 启动      ${dim('[2] 重启')}      ${dim('[3] 打开界面')}`);
      }
      say(`  ${bold('[4]')} 换端口    ${bold('[R]')} 刷新      ${bold('[Q]')} 退出`);
      say('');

      const raw = await ask('  选择: ');
      if (raw === null) break;
      const choice = raw.trim().toLowerCase();
      say('');

      if (choice === 'q' || choice === '') break;
      if (choice === 'r') continue;

      if (choice === '1') {
        await (inst ? cmdStop() : cmdStart());
      } else if (choice === '2') {
        if (!inst) say(dim('  没在运行，用 [1] 启动'));
        else await cmdRestart();
      } else if (choice === '3') {
        if (!inst) say(dim('  没在运行，用 [1] 启动'));
        else await cmdOpen();
      } else if (choice === '4') {
        const v = (await ask(`  新端口 (当前 ${savedPort()}): `))?.trim();
        if (v == null) break;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) {
          say(red('  端口要是 1024–65535 之间的整数'));
        } else {
          await cmdPort(n);
        }
      } else {
        say(dim(`  不认识的选项：${choice}`));
      }

      if ((await ask(dim('\n  回车继续…'))) === null) break;
    }
  } finally {
    rl.close();
  }
  return 0;
}

function cmdHelp() {
  say(`${bold('bbt')} ${dim('— Best Buy 降价雷达 控制程序')}

  ${bold('bbt')}                交互菜单（双击 bbt.cmd 也是进这个）
  ${bold('bbt status')}         看状态（没运行时退出码为 1）
  ${bold('bbt start')} [端口]    启动（不给端口就用配置里的）
  ${bold('bbt stop')}           停止（先让它保存数据再退）
  ${bold('bbt restart')} [端口]  重启
  ${bold('bbt port')} <端口>     改默认端口，在跑的话顺手重启
  ${bold('bbt open')}           浏览器里打开界面

${dim(`  配置端口：${savedPort()}`)}
${dim(`  数据目录：${DATA_DIR}`)}`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */
function parsePort(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    die(`端口不对：${v}（要 1024–65535 之间的整数）`);
  }
  return n;
}

const [cmd, arg] = process.argv.slice(2);

const run = async () => {
  // 不带命令 = 交互菜单。双击 bbt.cmd 时窗口靠它自己撑住，
  // 不用去猜"这次到底是双击还是终端调用"（两者在 cmd 里长得一模一样）。
  if (!cmd) return process.stdin.isTTY ? cmdMenu() : cmdStatus();

  switch (cmd.toLowerCase()) {
    case 'menu':                               return cmdMenu();
    case 'status': case 'st':                  return cmdStatus();
    case 'start': case 'up':                   return cmdStart(parsePort(arg));
    case 'stop': case 'down': case 'kill':     return cmdStop();
    case 'restart': case 'rs':                 return cmdRestart(parsePort(arg));
    case 'port':                               return cmdPort(parsePort(arg));
    case 'open': case 'ui':                    return cmdOpen();
    case 'help': case '-h': case '--help':     return cmdHelp();
    default:
      say(red(`不认识的命令：${cmd}`));
      return cmdHelp() || 1;
  }
};

// 只设 exitCode、不调 process.exit()：在 Windows 上把输出接到管道时，
// process.exit() 会把还没冲刷完的 stdout 直接截断（丢过一行提示）。
// 让事件循环自然跑空，输出才是完整的。
run()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((e) => {
    if (e instanceof ExitSignal) return;         // die() 已经打印过了
    console.error(red('✗ ') + (e?.stack || e?.message || String(e)));
    process.exitCode = 1;
  });
