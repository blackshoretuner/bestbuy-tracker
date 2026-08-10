#!/usr/bin/env node
/**
 * 打便携版：解压即用，目标机器不用装 Node、不用管理员权限。
 *
 *   node scripts/build-portable.js              用本机的 node.exe
 *   node scripts/build-portable.js --node <路径> 指定别的 node.exe
 *   node scripts/build-portable.js --no-zip     只出文件夹，不压缩
 *
 * 为什么是"带 node.exe 的文件夹"而不是单个 .exe：
 * 本项目是 ESM 多模块 + import.meta.url，Node 内置的 SEA 只吃单文件 CJS，
 * 要先用打包器转成 CJS 才行——多一层转换就多一层出错的地方（动态 import、
 * import.meta、__dirname 语义都会变）。带一个官方 node.exe 最省事也最稳，
 * 代价只是体积大一点。pkg 已经不维护且不支持新版 Node，直接排除。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const APP_NAME = 'BestBuy-Price-Tracker';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const OUT = path.join(DIST, APP_NAME);

/* ------------------------------------------------------------------ */
/* 要打进去的东西                                                       */
/* ------------------------------------------------------------------ */
const INCLUDE_DIRS = ['src', 'public'];
const INCLUDE_FILES = ['server.js', 'package.json'];
// scripts 里只带运行时需要的，构建脚本和演示数据不进包
const INCLUDE_SCRIPTS = ['ctl.js'];

const step = (n, msg) => console.log(`\x1b[36m[${n}/7]\x1b[0m ${msg}`);
const ok = (msg) => console.log(`      \x1b[32m✓\x1b[0m ${msg}`);
const warn = (msg) => console.log(`      \x1b[33m!\x1b[0m ${msg}`);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

const mb = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';

/* ------------------------------------------------------------------ */
/* 1. 清理                                                             */
/* ------------------------------------------------------------------ */
step(1, '清理输出目录');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
ok(path.relative(ROOT, OUT));

/* ------------------------------------------------------------------ */
/* 2. 拷程序文件                                                        */
/* ------------------------------------------------------------------ */
step(2, '拷贝程序文件');
for (const d of INCLUDE_DIRS) {
  copyDir(path.join(ROOT, d), path.join(OUT, d));
  ok(`${d}/`);
}
for (const f of INCLUDE_FILES) {
  fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
  ok(f);
}
fs.mkdirSync(path.join(OUT, 'scripts'), { recursive: true });
for (const f of INCLUDE_SCRIPTS) {
  fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(OUT, 'scripts', f));
  ok(`scripts/${f}`);
}
// data/ 是用户数据，绝对不能打进包里（里面有可能存着 API Key）
ok('已跳过 data/（用户数据，含可能的 API Key）');

/* ------------------------------------------------------------------ */
/* 3. 带上 Node 运行时                                                  */
/* ------------------------------------------------------------------ */
step(3, '打包 Node 运行时');
const nodeSrc = opt('--node') || process.execPath;
if (!fs.existsSync(nodeSrc)) {
  console.error(`\x1b[31m✗\x1b[0m 找不到 node.exe：${nodeSrc}`);
  process.exit(1);
}
const runtimeDir = path.join(OUT, 'runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
fs.copyFileSync(nodeSrc, path.join(runtimeDir, 'node.exe'));

let nodeVersion = 'unknown';
try {
  nodeVersion = execFileSync(nodeSrc, ['-v'], { encoding: 'utf8' }).trim();
} catch { /* 版本号取不到不影响打包 */ }
ok(`node.exe ${nodeVersion} (${mb(fs.statSync(nodeSrc).size)})`);

// Node 官方 Windows 版是静态链接的，node.exe 自己就能跑；
// 但如果是从某些自定义构建里拷来的，可能会带 DLL 依赖，一并搬过去。
const nodeDir = path.dirname(nodeSrc);
for (const f of fs.readdirSync(nodeDir)) {
  if (/\.dll$/i.test(f)) {
    fs.copyFileSync(path.join(nodeDir, f), path.join(runtimeDir, f));
    warn(`附带 DLL：${f}`);
  }
}

/* ------------------------------------------------------------------ */
/* 4. 启动器                                                            */
/* ------------------------------------------------------------------ */
step(4, '生成启动器');

// 批处理内容必须是纯 ASCII：cmd.exe 按 OEM 代码页解析 .cmd，
// 中文字节会把 if/echo 的块结构打乱。中文提示统统交给 Node 输出。
const LAUNCHER = `@echo off
setlocal
cd /d "%~dp0"

if not exist "runtime\\node.exe" (
  echo.
  echo   Broken package: runtime\\node.exe is missing.
  echo   Re-extract the whole folder from the zip.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting Best Buy Price Tracker...
echo   Your browser will open at http://127.0.0.1:8787
echo   Closing this window quits the app.
echo.

"runtime\\node.exe" server.js
echo.
echo   Server stopped.
pause
exit /b 0
`;

const CONTROL = `@echo off
setlocal
cd /d "%~dp0"

if not exist "runtime\\node.exe" (
  echo Broken package: runtime\\node.exe is missing.
  pause
  exit /b 1
)

"runtime\\node.exe" scripts\\ctl.js %*
exit /b %ERRORLEVEL%
`;

fs.writeFileSync(path.join(OUT, '启动.cmd'), LAUNCHER, 'ascii');
fs.writeFileSync(path.join(OUT, 'bbt.cmd'), CONTROL, 'ascii');
ok('启动.cmd（双击运行）');
ok('bbt.cmd（起停 / 换端口）');

// ctl.js 里是用 process.execPath 拉起服务的，便携版下它就是
// runtime\node.exe，所以子进程天然也用打包进来的这个运行时。

/* ------------------------------------------------------------------ */
/* 5. 说明文件                                                          */
/* ------------------------------------------------------------------ */
step(5, '写使用说明');

const READ_ME = `Best Buy 降价雷达 · 便携版
${'='.repeat(46)}

怎么用
------
1. 把整个文件夹解压出来（别在压缩包里直接双击）
2. 双击「启动.cmd」
3. 浏览器会自动打开 http://127.0.0.1:8787
4. 点右上角「立即查询」跑第一轮，之后每 30 分钟自动查一次
5. 关掉那个黑窗口就等于退出

不需要装 Node.js，不需要管理员权限，不需要注册任何账号。


前提条件
--------
· Windows 10 / 11 64 位
· 本机装有 Microsoft Edge 或 Google Chrome
  （默认通道是用浏览器去读 Best Buy 的网页；Win10/11 自带 Edge，一般都满足）


起停和换端口
------------
在这个文件夹里开命令行（地址栏输 cmd 回车），然后：

  bbt              交互菜单（双击 bbt.cmd 也是这个）
  bbt status       看状态
  bbt start        后台启动
  bbt start 9000   换个端口启动
  bbt stop         停止
  bbt port 9000    永久改端口

端口 8787 被别的程序占了的话，用 bbt port 换一个。


数据存哪
--------
就在本文件夹的 data\\ 里。整个文件夹拷到别的电脑，历史记录跟着走。
如果解压到了 Program Files 这类写不进去的地方，会自动改存到
%LOCALAPPDATA%\\BestBuyTracker\\data，启动日志里会写明。

想彻底重来：把 data\\ 删掉即可。


常见问题
--------
· 双击没反应 / 窗口一闪而过
  → 先确认整个文件夹完整解压了，runtime\\node.exe 必须在
  → 在文件夹里开 cmd，敲 启动.cmd，就能看到报错

· 提示找不到 Edge 或 Chrome
  → 装一个 Chrome，或改用官方 API 通道（设置里切换）

· 历史记录里「降价」是空的
  → 正常。要等同一台机器在两轮查询之间真的降价才会有记录，
    Best Buy 的促销大致按周更新。先看「新发现」或「全部」。

· 杀毒软件报警
  → runtime\\node.exe 是 Node.js 官方运行时原件，加白名单即可


构建信息
--------
应用版本   ${pkg.version}
Node 运行时 ${nodeVersion}
打包时间   ${new Date().toLocaleString('zh-CN')}
`;

fs.writeFileSync(path.join(OUT, '使用说明.txt'), '﻿' + READ_ME, 'utf8');
ok('使用说明.txt');

fs.writeFileSync(
  path.join(OUT, 'build-info.json'),
  JSON.stringify(
    {
      app: pkg.name,
      version: pkg.version,
      nodeRuntime: nodeVersion,
      builtAt: new Date().toISOString(),
      builtOn: `${process.platform}-${process.arch}`,
    },
    null,
    2
  ),
  'utf8'
);
ok('build-info.json');

/* ------------------------------------------------------------------ */
/* 6. 自检                                                             */
/* ------------------------------------------------------------------ */
step(6, '自检');
const mustExist = [
  'runtime/node.exe',
  'server.js',
  'scripts/ctl.js',
  'src/config.js',
  'public/index.html',
  '启动.cmd',
  'bbt.cmd',
];
let bad = 0;
for (const rel of mustExist) {
  if (!fs.existsSync(path.join(OUT, rel.replace(/\//g, path.sep)))) {
    console.error(`      \x1b[31m✗ 缺失：${rel}\x1b[0m`);
    bad++;
  }
}
if (bad) {
  console.error('\x1b[31m✗ 打包不完整\x1b[0m');
  process.exit(1);
}

const PORTABLE_NODE = path.join(OUT, 'runtime', 'node.exe');

// ctl.js 有顶层副作用（会真的去执行命令），不能 import，只做语法检查
try {
  execFileSync(PORTABLE_NODE, ['--check', 'scripts/ctl.js'], { cwd: OUT, stdio: 'pipe', timeout: 20000 });
  ok('scripts/ctl.js 语法检查：通过');
} catch (e) {
  console.error(`      \x1b[31m✗ ctl.js 有语法错误：${(e.stderr?.toString() || e.message).trim()}\x1b[0m`);
  process.exit(1);
}

/**
 * 真·冒烟测试：用打包进去的 node.exe 把服务整个跑起来，
 * 调通接口再关掉。比"能不能 import"有意义得多——这一步过了，
 * 基本就等于在目标机器上能跑。
 */
const smokeDir = path.join(DIST, '.smoke');
fs.rmSync(smokeDir, { recursive: true, force: true });

const freePort = await new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port;
    srv.close(() => resolve(p));
  });
});

const child = spawn(PORTABLE_NODE, ['server.js'], {
  cwd: OUT,
  env: { ...process.env, PORT: String(freePort), BBT_NO_OPEN: '1', BBT_DATA_DIR: smokeDir },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let childOut = '';
child.stdout.on('data', (d) => { childOut += d; });
child.stderr.on('data', (d) => { childOut += d; });

let info = null;
const deadline = Date.now() + 30000;
while (Date.now() < deadline && child.exitCode === null) {
  try {
    const res = await fetch(`http://127.0.0.1:${freePort}/api/instance`);
    if (res.ok) {
      const j = await res.json();
      if (j.app === 'bestbuy-price-tracker') { info = j; break; }
    }
  } catch { /* 还没起来，接着等 */ }
  await new Promise((r) => setTimeout(r, 400));
}

if (!info) {
  try { child.kill(); } catch { /* ignore */ }
  console.error('      \x1b[31m✗ 冒烟测试失败：服务没能起来\x1b[0m');
  console.error(childOut.trim().split('\n').slice(-8).map((l) => '        ' + l).join('\n'));
  process.exit(1);
}
ok(`服务用打包的 node.exe 起来了（PID ${info.pid}，端口 ${freePort}）`);

// 顺带确认页面和主要接口都通
for (const [label, urlPath] of [['首页', '/'], ['电脑榜接口', '/api/board?limit=1'], ['历史记录接口', '/api/events?limit=1']]) {
  const res = await fetch(`http://127.0.0.1:${freePort}${urlPath}`);
  if (!res.ok) {
    try { child.kill(); } catch { /* ignore */ }
    console.error(`      \x1b[31m✗ ${label} 返回 HTTP ${res.status}\x1b[0m`);
    process.exit(1);
  }
}
ok('首页 + 电脑榜 + 历史记录接口：全通');

// 用它自己的关机接口收摊，顺便验证这条链路在便携版里也好使
const pidRec = JSON.parse(fs.readFileSync(path.join(smokeDir, 'server.pid'), 'utf8'));
await fetch(`http://127.0.0.1:${freePort}/api/shutdown`, {
  method: 'POST',
  headers: { 'x-bbt-token': pidRec.token },
}).catch(() => {});
await new Promise((r) => setTimeout(r, 1200));
if (child.exitCode === null) { try { child.kill(); } catch { /* ignore */ } }
ok('优雅关机：通过');

fs.rmSync(smokeDir, { recursive: true, force: true });
// 冒烟测试用的是独立数据目录，但 config.js 探测时可能在包里建过 data/，清掉
fs.rmSync(path.join(OUT, 'data'), { recursive: true, force: true });
ok('已清理测试残留，包内不含任何用户数据');

/* ------------------------------------------------------------------ */
/* 7. 压缩                                                             */
/* ------------------------------------------------------------------ */
step(7, '压缩');
const folderSize = dirSize(OUT);

if (flag('--no-zip')) {
  warn('跳过压缩（--no-zip）');
} else {
  const zipPath = path.join(DIST, `${APP_NAME}-v${pkg.version}-win-x64.zip`);
  fs.rmSync(zipPath, { force: true });
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
      ],
      { stdio: 'pipe', timeout: 300000 }
    );
    ok(`${path.basename(zipPath)} (${mb(fs.statSync(zipPath).size)})`);
  } catch (e) {
    warn(`压缩失败：${(e.stderr?.toString() || e.message).trim().split('\n')[0]}`);
    warn('文件夹已经生成，手动右键压缩也行');
  }
}

console.log(`
\x1b[32m完成\x1b[0m  文件夹 ${mb(folderSize)}
      ${OUT}

拷到目标机器 → 解压 → 双击「启动.cmd」
`);
