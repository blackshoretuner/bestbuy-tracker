import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');

/**
 * 数据目录。优先放程序目录下的 data/ —— 便携版就该这样，拷走整个文件夹
 * 数据跟着走。但如果那儿写不了（解压到了 Program Files、或者在只读 U 盘上），
 * 就退到 %LOCALAPPDATA%，别让程序直接起不来。
 */
function resolveDataDir() {
  const candidates = [];
  if (process.env.BBT_DATA_DIR) candidates.push(path.resolve(process.env.BBT_DATA_DIR));
  candidates.push(path.join(ROOT, 'data'));
  const local = process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir();
  if (local) candidates.push(path.join(local, 'BestBuyTracker', 'data'));
  candidates.push(path.join(os.tmpdir(), 'BestBuyTracker', 'data'));

  const problems = [];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // 建得出来不代表写得进去（只读介质、组策略），实际写一下才算数
      const probe = path.join(dir, '.writetest');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      if (problems.length) console.warn(`[配置] ${problems.join('；')}，数据改存到 ${dir}`);
      return dir;
    } catch (e) {
      problems.push(`${dir} 不可写 (${e.code || e.message})`);
    }
  }
  throw new Error('找不到可写的数据目录：\n  ' + problems.join('\n  '));
}

export const DATA_DIR = resolveDataDir();

export const DEFAULT_SETTINGS = {
  // ---- 数据源 ----
  apiKey: '',                    // developer.bestbuy.com 免费申请（需要美国手机号）

  // 默认走 web：用本机 Edge/Chrome 读 Best Buy 的搜索结果页，不需要任何 Key。
  //   web  — 浏览器读网页，零门槛，规格靠商品名解析（重量等字段会缺）
  //   api  — 官方开放平台，字段最全最稳，但注册要美国手机号
  //   auto — 有 Key 走 API，没 Key 或查不到时回落到 web
  provider: 'web',               // web | api | auto

  // 无头模式没有窗口、更省资源；代价是 Best Buy 每页给的商品大约只有窗口模式的一半。
  // 关掉就用真实窗口（会被移到屏幕外，你看不见）。被拦了不归它管 —— 被拦就停手，不绕过。
  browserHeadless: true,
  browserPath: '',               // 留空自动找 Edge，再找 Chrome
  maxPagesPerSearch: 2,          // 每条搜索翻几页（一页约 15–20 台）
  hideThirdParty: false,         // 隐藏 Marketplace 第三方卖家的商品

  includeOpenBox: true,          // 额外查 Open Box(展示样机/退货重售) 报价

  // ---- 调度 ----
  autoStart: true,               // 服务启动后自动开始定时查询
  runOnLaunch: true,             // 启动后立刻先跑一轮
  intervalMinutes: 30,
  jitterPercent: 12,             // 每轮间隔随机浮动，避免固定节奏
  quietHours: { enabled: false, start: '23:30', end: '08:00' },

  // ---- 降价判定 ----
  dropMinPercent: 0,             // 降幅小于该百分比不记事件/不通知
  dropMinAmount: 0,              // 降幅小于该金额(美元)不记事件/不通知
  recordEveryObservation: true,  // 每次采样都写入价格曲线(用于图表)

  // ---- 特别关注 ----
  // 盯住某个品牌/型号，大降价第一时间通知。命中时**绕开**下面的
  // dropMinPercent/dropMinAmount 全局阈值，也不受 notify.maxPerCycle 压制。
  // 规则结构见 src/alerts.js 的 ALERT_DEFAULTS。
  alerts: [],

  // ---- 通知 ----
  notify: {
    toast: true,                 // Windows 桌面通知
    sound: false,
    onlyWatchlist: false,        // 只对关注列表通知，忽略自动搜索的新发现
    maxPerCycle: 6,
  },

  // ---- 手机推送 ----
  // 电脑前不在的时候也能收到。详见 src/phone.js。
  phone: {
    enabled: false,
    provider: 'ntfy',              // ntfy（iOS/Android，免注册）| bark（iOS）
    ntfyServer: 'https://ntfy.sh', // 自建 ntfy 的话改这里
    ntfyTopic: '',                 // 主题名就是密码，用随机长串
    barkServer: 'https://api.day.app',
    barkKey: '',
    onlyAlerts: true,              // 只推特别关注的命中；关掉则普通降价也推（限量）
    maxPerCycle: 3,                // 普通降价每轮最多推几条（特别关注不受限）
  },

  // ---- 网络 ----
  requestsPerSecond: 4,          // 官方 API 限速 5 req/s
  scrapeDelayMs: 2500,           // 抓取模式下每个请求之间的间隔
  requestTimeoutMs: 20000,

  // ---- 过滤 ----
  // 只保留能识别成笔电/台式/一体机的结果，把配件、包、鼠标之类全滤掉
  onlyComputers: true,

  // ---- 值不值的判定 ----
  // 历史分位看多久之内的价格。窗口太短会把"一直贵"误判成"历史低位"。
  histWindowDays: 90,
  // 跟踪时长不够 / 价格从没变过，就不给分位，老实说数据不足
  histMinDays: 3,
  // 同档横向对比至少要有几台样本才算数
  crossMinSamples: 5,
  // 配件的门槛低一些：整机的"同档"是靠四级阶梯凑出来的近似分组（配置千差万别），
  // 而"同一颗芯片 + 同样显存"是**精确同款**对比，3 张卡的价差就已经能说明问题。
  crossMinSamplesHardware: 3,
  // "真好价" = 自身历史分位 ≤ 这个 且 同档分位 ≤ 下面那个
  trueDealHistPct: 15,
  trueDealCrossPct: 35,

  // 已经补种过的种子搜索 id。升级时靠它判断哪些新种子还没给过用户，
  // 也保证用户删掉某条种子后不会在下次启动时又被塞回来。见 store.ensureSeedSearches()
  seededSearchIds: [],

  // boardKey 是否已迁成带零售商的三段式。见 store.migrateRetailerKeys()
  retailerKeysMigrated: false,

  // ---- 存储 ----
  priceHistoryDays: 180,
  keepObservationDays: 120,
  maxDiscoverPerSearch: 60,

  // ---- 服务 ----
  port: 8787,
  openBrowserOnStart: true,
};

// 重心在电脑上。Best Buy 会调整分类树，所以设置页里带了一个"分类查找"
// 工具，可以直接查实时 ID 覆盖这里的值。
export const SEED_CATEGORIES = [
  { id: 'abcat0502000', name: '笔记本电脑 (Laptops)', group: '电脑' },
  { id: 'abcat0501000', name: '台式机 (Desktops)', group: '电脑' },
  { id: 'abcat0500000', name: '电脑与平板 (全部)', group: '电脑' },
  { id: 'abcat0513000', name: '一体机 (All-in-One)', group: '电脑' },
  { id: 'abcat0507000', name: '显示器 (Monitors)', group: '外设' },
  { id: 'pcmcat209000050006', name: '平板 (Tablets)', group: '其它' },
  { id: 'abcat0800000', name: '手机 (Cell Phones)', group: '其它' },
  { id: 'abcat0100000', name: '电视与影音', group: '其它' },
  { id: 'abcat0400000', name: '相机', group: '其它' },
  { id: 'abcat0700000', name: '游戏', group: '其它' },
];

export const CONDITIONS = [
  { value: 'any', label: '不限' },
  { value: 'new', label: '全新' },
  { value: 'refurbished', label: '官翻 Refurbished' },
  { value: 'preowned', label: '二手 Pre-Owned' },
  { value: 'openbox', label: 'Open Box 拆封' },
];

const searchDefaults = {
  enabled: true,
  channel: 'api',
  // 这条搜索是找整机还是找单件硬件。决定结果怎么过滤（见 tracker.js）：
  // computer 只留笔电/台式/一体机，hardware 只留显卡/CPU/内存/固态/显示器。
  // 不给的话默认 computer —— 老的搜索配置读上来行为完全不变。
  kind: 'computer',
  // 去哪家查。bestbuy 走 bestbuyWeb，bh 走 bhWeb（各自的 URL/卡片/价格写法完全不同）。
  // 不给的话默认 bestbuy —— 老的搜索配置读上来行为完全不变。
  retailer: 'bestbuy',
  // B&H 用分类页而不是关键词，part 指明品类（gpu/cpu/ram/ssd）
  part: null,
  keywords: '',
  condition: 'any',
  minPrice: null,
  maxPrice: null,
  minPercentOff: 0,
  onSaleOnly: false,
  sort: 'percentSavings.desc',
  limit: 60,
};

/**
 * 默认搜索故意不加 onSaleOnly / minPercentOff。
 *
 * 降价是本软件自己算出来的——把机器收进「电脑榜」持续跟踪，价格一跌就记一笔。
 * 如果一开始就只收"Best Buy 已经标了折扣"的商品，那些原价挂着、后来悄悄降价的
 * 机器根本进不了榜，也就永远发现不了它降价。宁可多收，让时间去发现降价。
 */
export function seedSearches() {
  const now = Date.now();
  const mk = (o) => ({ ...searchDefaults, ...o, createdAt: now });
  return [
    mk({
      id: 'seed-gaming-laptop',
      name: '游戏本',
      categoryId: 'abcat0502000',
      keywords: 'gaming',
      limit: 60,
    }),
    mk({
      id: 'seed-laptop-all',
      name: '笔记本 · 全线',
      categoryId: 'abcat0502000',
      limit: 60,
    }),
    mk({
      id: 'seed-desktop',
      name: '台式机',
      categoryId: 'abcat0501000',
      limit: 40,
    }),
    mk({
      id: 'seed-refurb-computers',
      name: '电脑 · 官翻/二手',
      categoryId: 'abcat0500000',
      condition: 'refurbished',
      sort: 'salePrice.asc',
      limit: 60,
    }),
    mk({
      id: 'seed-openbox-computers',
      name: '电脑 · Open Box 拆封',
      channel: 'openbox',
      categoryId: 'abcat0500000',
      condition: 'openbox',
      sort: 'salePrice.asc',
      limit: 60,
    }),
    // 硬件：只给关键词、不给 categoryId。
    // 网页通道本来就是把 categoryId 映射成关键词去搜的（见 bestbuyWeb.js 的
    // CATEGORY_TERMS），而配件的 Best Buy 分类 ID 没有 API Key 没法查证，
    // 与其写一个猜的 ID，不如直接用关键词 —— 实测 "graphics card" 命中率 20/20。
    mk({
      id: 'seed-gpu',
      name: '显卡',
      kind: 'hardware',
      keywords: 'graphics card',
      sort: 'salePrice.asc',
      limit: 60,
    }),
    mk({
      id: 'seed-cpu',
      name: 'CPU',
      kind: 'hardware',
      keywords: 'cpu processor',
      sort: 'salePrice.asc',
      limit: 40,
    }),
    mk({
      id: 'seed-ram',
      name: '内存',
      kind: 'hardware',
      keywords: 'desktop memory ram',
      sort: 'salePrice.asc',
      limit: 40,
    }),
    mk({
      id: 'seed-ssd',
      name: '固态 / 硬盘',
      kind: 'hardware',
      keywords: 'internal ssd',
      sort: 'salePrice.asc',
      limit: 40,
    }),
    // ---- B&H：同一件配件在两家的比价，才是值不值最硬的证据 ----
    mk({ id: 'seed-bh-gpu', name: 'B&H · 显卡', kind: 'hardware', retailer: 'bh', part: 'gpu', limit: 40 }),
    mk({ id: 'seed-bh-cpu', name: 'B&H · CPU', kind: 'hardware', retailer: 'bh', part: 'cpu', limit: 40 }),
    mk({ id: 'seed-bh-ram', name: 'B&H · 内存', kind: 'hardware', retailer: 'bh', part: 'ram', limit: 40 }),
    mk({ id: 'seed-bh-ssd', name: 'B&H · 固态', kind: 'hardware', retailer: 'bh', part: 'ssd', limit: 40 }),
    // ---- 盯具体型号：泛词搜索（"laptop"）翻不到具体机型，想跟哪台就单开一条 ----
    // 实测效果：只靠泛词时榜上只有 3 台幻14 且全是 Best Buy；
    // 加了这两条之后 17 台、跨两家，同配置价差一眼可见
    //（Ryzen 9 + 5060 + 16G：amazon $1849.71 vs bestbuy $2299.99）。
    // **不给 B&H 开**：B&H 的关键词搜索 /c/search?q= 走我们的提取器返回 0 件
    //（不是被拦，是页面结构不同），B&H 只能走分类页。
    mk({
      id: 'seed-g14-bestbuy',
      name: '幻14 · Best Buy',
      categoryId: 'abcat0502000',
      keywords: 'zephyrus g14',
      sort: 'salePrice.asc',
      limit: 30,
    }),
    mk({
      id: 'seed-g14-amazon',
      name: '幻14 · Amazon',
      retailer: 'amazon',
      keywords: 'zephyrus g14',
      sort: 'salePrice.asc',
      limit: 30,
    }),
    // ---- 整机也要多平台：同一台笔电在三家的价格才比得出值不值 ----
    mk({ id: 'seed-bh-laptop', name: 'B&H · 笔电', kind: 'computer', retailer: 'bh', part: 'laptop', limit: 40 }),
    mk({ id: 'seed-bh-desktop', name: 'B&H · 台式', kind: 'computer', retailer: 'bh', part: 'desktop', limit: 30 }),
    mk({ id: 'seed-amz-laptop', name: 'Amazon · 笔电', kind: 'computer', retailer: 'amazon', part: 'laptop', limit: 40 }),
    mk({ id: 'seed-amz-desktop', name: 'Amazon · 台式', kind: 'computer', retailer: 'amazon', part: 'desktop', limit: 30 }),
    // ---- Amazon：商品最全，但同款重复/第三方 listing 也最多 ----
    // 不给 categoryId：Amazon 没有 B&H 那种干净的分类页，关键词搜索才是正路
    //（part → 关键词的映射在 amazonWeb.js 的 PART_TERMS）
    mk({ id: 'seed-amz-gpu', name: 'Amazon · 显卡', kind: 'hardware', retailer: 'amazon', part: 'gpu', limit: 40 }),
    mk({ id: 'seed-amz-cpu', name: 'Amazon · CPU', kind: 'hardware', retailer: 'amazon', part: 'cpu', limit: 40 }),
    mk({ id: 'seed-amz-ram', name: 'Amazon · 内存', kind: 'hardware', retailer: 'amazon', part: 'ram', limit: 40 }),
    mk({ id: 'seed-amz-ssd', name: 'Amazon · 固态', kind: 'hardware', retailer: 'amazon', part: 'ssd', limit: 40 }),
  ];
}
