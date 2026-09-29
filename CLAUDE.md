# Best Buy 降价雷达 — 给下一个会话的交接

个人自用工具：定时扫 Best Buy / B&H / Amazon 的**电脑**（笔电/台式/一体机，含官翻和 Open Box）
和**配件**（显卡/CPU/内存/固态），按配置拆列展示，判断「现在这个价到底值不值」，
降价写进历史记录并弹 Windows 通知（可选推到手机）。

灵感来自 B 站「北美垃圾佬」。目标是自用捡漏，不是做内容账号。

---

## 跑起来

```bash
bbt              # 交互菜单（双击 bbt.cmd 也是这个）
bbt status       # 端口 / PID / 运行多久（没运行时退出码 1）
bbt start [端口]  # 后台启动
bbt stop         # 优雅停止（先落盘再退）
bbt port 9000    # 改默认端口，在跑的话顺手重启
npm run build    # 打便携版 → dist/*.zip
```

`start.cmd` 是前台窗口版（双击用），和 `bbt` 管的是同一个实例。
界面 http://127.0.0.1:8787。零 npm 依赖，不要引入。

---

## 硬约束

- **拿不到官方 API Key** —— 注册要美国手机号，用户没有。所以默认通道是
  `web`（驱动本机 Edge/Chrome 读搜索结果页）。API 相关代码保留着，但别把
  任何功能设计成「必须有 Key 才能用」。
- **Windows only**，PowerShell 5.1 环境。
- 用户不答技术选型的选择题，见记忆 `decide-dont-ask`。

---

## 代码地图

```
server.js              HTTP + 路由 + SSE + 静态文件
src/
  config.js            默认设置；DATA_DIR 探测（可写性回退）
  store.js             JSON/JSONL 持久化，原子写
  tracker.js           调度器：轮询 → 判定 → 写事件 → 通知
  specs.js             商品名 → cpu/gpu/ram/disk/weight/screen 拆列；识别单件配件
  analytics.js         同档横向分位 + 自身历史时间加权分位 + 评分
  alerts.js            特别关注规则（命中时绕开全局降价阈值）
  instance.js          pid 文件 + 实例 token
  notify.js            Windows toast（WinRT，无依赖）
  phone.js             手机推送（ntfy / Bark）
  browser/cdp.js       CDP 驱动 Edge/Chrome；残留 profile 回收
  providers/
    bestbuyWeb.js      默认通道：浏览器读网页
    bhWeb.js           B&H（只走分类页）
    amazonWeb.js       Amazon（关键词搜索）
    bestbuyApi.js      官方 API（需 Key，目前用不了）
    scrape.js          裸 HTTP 兜底（基本必被拦）
public/                原生 JS 单页，无框架
scripts/ctl.js         bbt 的实现
scripts/build-portable.js  打包
```

**数据文件**（`data/`，不进 git 也不进发布包）：
`settings.json` `board.json`（每台机器当前快照）`events.jsonl`（历史记录）
`pricelog.jsonl`（价格轨迹，**只在变价时追加**）`watchlist.json` `searches.json`

---

## 核心设计决策（改之前先看这里）

### 值不值：两把尺子，缺一不可

`analytics.js` 里的两个指标，都**明确报告数据够不够**，宁可说「数据不足」也不吐没有统计意义的数字。

1. **同档横向分位** —— 同配置的机器现在都卖多少，这台排第几。
   四级阶梯 `form|gpu|ram|disk → form|gpu|ram → form|gpu|cpu档 → form|gpu`，
   取样本量 ≥5 的最细一层，并把用的哪一层显示给用户。
   *为什么不用折扣 %*：Best Buy 的 `regularPrice` 常年虚高，-40% 可能只是虚标。

2. **自身历史分位** —— 当前价在过去 90 天分布里的位置，**按时间加权**。
   *为什么不按采样点数*：采样密度随查询频率变，按点数算会让高频时段权重虚高。
   *为什么不用「比上次低」*：$2000 涨到 $2400 再跌回 $2300 也是「降价」，
   但那是历史高位。时间加权分位能正确否掉这种。

**评分**：两个都有数据才给满分区间；只有单边证据的压到 **70 分封顶** ——
不压的话，「同档没样本、只是自己历史上便宜」的机器能拿 95 分排在证据完整的真好价前面。

**真好价** = 历史分位 ≤15% **且** 同档分位 ≤35%。阈值在 settings 里。

### 规格解析（specs.js）

Best Buy 商品名高度结构化，`" - "` 分段就能拿到大部分信息。
`details` 数组（只有 API 通道有）作为补充。

**核显推断**：电脑类商品翻遍名字和参数都没有独显关键词 → 判定为核显，
标 `gpuInferred: true`。这条让同档可比样本从 42 台涨到 54 台（122 台里 69 台是核显机）。
Best Buy 有独显必写在标题里，所以「没写」是很强的信号。

### 「新低」不能滥标

`upsertBoard` 会先把 `minPrice` 更新成新价，所以判断新低必须跟 `prevMinPrice` 比，
并要求 `seenCount >= 3`。否则刚跟踪两轮的机器全是「新低」。

---

## 踩过的坑（别再踩）

**批处理文件内容必须纯 ASCII。** cmd.exe 按 OEM 代码页解析 `.cmd`，
中文字节会打乱 `if` 块结构。中文提示一律交给 Node 输出。文件名可以是中文。

**`process.exit()` 在 Windows 管道下会截断 stdout。** `ctl.js` 里改成只设
`process.exitCode`、让事件循环自然跑空。别改回去。

**双击和 PowerShell 调用无法区分。** 两者的 `%cmdcmdline%` 都是
`cmd.exe /c ""路径""`。所以 `bbt` 不带参数 = 进交互菜单（菜单自己撑住窗口），
不要试图做「双击才 pause」的判断。

**`PORT` 环境变量残留会静默劫持端口。** `bbt start` 会显式从子进程环境里
删掉 `PORT`。端口存在 `settings.json`，不走环境变量。

**同一程序的多份拷贝会互相误伤。** 便携版会被拷来拷去，两份都用默认 8787。
`/api/instance` 上报安装目录 `root`，`ctl.js` 比对后拒绝操作别人家的实例。

**空状态文案要区分「一条都没有」和「筛选没命中」。** 这个坑踩了两次
（历史记录页、电脑榜）。榜上明明 122 台却显示「还没有记录」，看着就像坏了。
新加筛选条件时记得同步 `emptyBoardMessage()` / `emptyEventsMessage()`。

**Edge 会把自己「转交」给另一个进程。** 我们 spawn 的 msedge.exe 可能以 code 0 立刻退出，
真浏览器是另一个进程 —— PID 不是我们手里那个，stderr 也不在我们的管道上。
2026-09-24~25 那一版 Edge（有更新在排队时）一直这样；旧代码判成启动失败，真浏览器就没人管，
无头跑了 17 个小时，一天攒了 40 多个、11 GB 的一次性 profile。现在的处理（`cdp.js`）：
读 `<profile>/DevToolsActivePort` 接上它；「浏览器退干净了」以 profile 的 lockfile 删得掉为准，
**不看 PID**；`sweepStaleProfiles()` 每小时回收残留的一次性目录。别改回按 PID 判断。

**关机要优雅。** `Stop-Process -Force` 是 TerminateProcess，数据来不及落盘。
走 `POST /api/shutdown`（要带 pid 文件里的 token，防浏览器 CSRF），
卡住不响应才升级强杀。

---

## 打包

`npm run build` 产出「带 node.exe 的文件夹 + zip」，不是单个 exe。
*为什么*：本项目是 ESM 多模块 + `import.meta.url`，Node 的 SEA 只吃单文件 CJS，
得先用打包器转换，动态 import / `import.meta` / `__dirname` 语义都会变。
`pkg` 已停止维护且不支持新版 Node。带官方 node.exe 最稳，代价只是 88MB。

构建脚本会**真跑一遍冒烟测试**：用打进包的 node.exe 启动服务，验证首页 +
电脑榜接口 + 历史记录接口 + 优雅关机，再清理。这步过了基本等于目标机器能跑。
包里**不含 `data/`**（可能有 API Key）。

---

## 当前状态（2026-09-28）

- 电脑榜 624 台（Best Buy 256 / Amazon 368；B&H 整机暂时 0 台），同档可比 604 台，有历史分位的 242 台
- 硬件榜 638 件（Best Buy 227 / B&H 90 / Amazon 321），同档可比 466 件，有历史分位的 139 件
- 历史分位要 ≥3 天跟踪 **且** 价格确实变动过才给，没给的显示「—」。这是数据问题不是 bug，
  界面顶部有说明条
- B&H 时不时整轮拦截（「请稍候…」），拦了就跳过本轮剩下的 B&H 搜索，下一轮再试

## 验证习惯

改完要**真的验证**，不要只说「应该能用」：
- 算法改动 → 写临时脚本注入构造数据跑一遍（放 scratchpad，别进仓库）
- UI 改动 → `bbt restart` 后用浏览器工具读 DOM / 执行 JS 断言，不靠截图
- 打包改动 → 解压到全新目录当「另一台电脑」跑
- 报告结果要如实：失败就说失败并贴输出，跳过的步骤要讲明
