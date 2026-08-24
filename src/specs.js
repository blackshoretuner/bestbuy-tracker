/**
 * 规格解析：把 Best Buy 的商品名 + details 拆成 cpu / gpu / ram / disk / weight 等列。
 *
 * Best Buy 的商品名本身高度结构化，用 " - " 分段就能拿到大部分信息：
 *   ASUS - ROG Zephyrus G16 16" OLED 240Hz Gaming Laptop - Intel Core Ultra 9 285H
 *        - 32GB Memory - NVIDIA GeForce RTX 5080 - 2TB SSD - Platinum White
 * details 数组（API 的 show=details.name,details.value）作为补充和校正。
 */

const LB_TO_KG = 0.45359237;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
function detailMap(details) {
  const map = new Map();
  for (const d of details || []) {
    if (!d?.name) continue;
    map.set(String(d.name).toLowerCase().trim(), String(d.value ?? '').trim());
  }
  return map;
}

function pick(map, ...keys) {
  for (const k of keys) {
    const v = map.get(k.toLowerCase());
    if (v && v !== 'N/A' && v !== 'Not Applicable') return v;
  }
  return null;
}

function firstNum(s) {
  const m = String(s || '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------------ */
/* CPU                                                                 */
/* ------------------------------------------------------------------ */
const CPU_FAMILY = [
  [/intel\s+core\s+ultra\s*([3579])/i, (m) => `u${m[1]}`],
  [/core\s+ultra\s*([3579])/i, (m) => `u${m[1]}`],
  [/intel\s+core\s+i([3579])/i, (m) => `i${m[1]}`],
  [/\bcore\s+i([3579])\b/i, (m) => `i${m[1]}`],
  [/\bi([3579])[-\s]?\d{4,5}[a-z]{0,3}\b/i, (m) => `i${m[1]}`],
  [/amd\s+ryzen\s+ai\s+(?:max\+?\s*)?([3579])/i, (m) => `rAI${m[1]}`],
  [/(?:amd\s+)?ryzen\s+([3579])/i, (m) => `r${m[1]}`],
  [/\br([3579])[-\s]?\d{4}[a-z]{0,3}\b/i, (m) => `r${m[1]}`],
  [/apple\s+(m[1-9])\s*(pro|max|ultra)?/i, (m) => `${m[1].toUpperCase()}${m[2] ? ' ' + m[2][0].toUpperCase() + m[2].slice(1).toLowerCase() : ''}`],
  // 商品名里常写成 "M4 Pro chip"，前面并没有 Apple 字样
  [/\b(m[1-9])\s+(pro|max|ultra)\b/i, (m) => `${m[1].toUpperCase()} ${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()}`],
  [/\b(m[1-9])\s+chip\b/i, (m) => m[1].toUpperCase()],
  [/snapdragon\s+x\s+(elite|plus)/i, (m) => `SDX ${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}`],
  [/intel\s+(celeron|pentium|atom)/i, (m) => m[1].slice(0, 3).toLowerCase()],
  [/mediatek/i, () => 'MTK'],
];

// 型号里的年份（"OmniBook Ultra 2026"）很容易被误当成 CPU 编号，
// 所以裸数字单独一条规则并且排掉年份区间。
const YEAR_LIKE = (s) => {
  const n = Number(s);
  return Number.isInteger(n) && n >= 2015 && n <= 2035;
};

const CPU_MODEL = [
  /\b(\d{3,5}[A-Z]{1,4}\d?[A-Z]?)\b/i,   // 285H, 13620H, 14900HX, 7235HS, 7800X3D
  /\bHX\s?(\d{3})\b/i,                   // AMD Ryzen AI 9 HX 370
  /\b(\d{4,5})\b/,                       // 裸编号：7700, 12400（排年份）
];

function parseCpu(nameSegs, map, fullText) {
  const explicit = pick(map, 'processor model', 'processor', 'cpu');
  const modelNum = pick(map, 'processor model number', 'processor number');

  // 名字里 " - " 分段中最像 CPU 的那一段
  const seg = nameSegs.find((s) =>
    /intel|amd|ryzen|core\s|core$|\bm[1-9]\s+(pro|max|ultra|chip)\b|snapdragon|celeron|pentium/i.test(s)
  );
  const source = [explicit, seg, fullText].filter(Boolean).join(' ');

  let family = null;
  let familyEnd = -1;
  for (const [re, fn] of CPU_FAMILY) {
    const m = source.match(re);
    if (m) {
      family = fn(m);
      familyEnd = m.index + m[0].length;
      break;
    }
  }
  if (!family) return null;

  // Apple / Snapdragon 本身就是完整型号
  if (/^M[1-9]|^SDX/.test(family)) return family;

  let model = modelNum;
  if (!model) {
    // 关键：只在 CPU 家族名后面一小段里找型号。放开了搜整个商品名的话，
    // "144Hz" "165Hz" 这种刷新率会被当成 CPU 编号（i7 165HZ）。
    const scope = source.slice(familyEnd, familyEnd + 42);
    // 只有 Core Ultra 是 3 位编号（285H / 255H / 226V）。Core i 和 Ryzen 都是
    // 4-5 位（13620H / 7745HX）。不加这条限制，"240Hz" 会被切成 "240H" 当成 Ryzen 型号。
    const allow3 = /^u\d$/.test(family);
    for (const re of CPU_MODEL) {
      const m = scope.match(re);
      if (!m) continue;
      const candidate = m[0].toUpperCase().startsWith('HX') ? `HX ${m[1]}` : m[1];
      if (YEAR_LIKE(candidate)) continue;                  // 年份
      if (/HZ$/i.test(candidate)) continue;                // 刷新率
      if (/^\d+(GB|TB|MB|W)$/i.test(candidate)) continue;  // 容量/功率
      if (!allow3 && /^\d{3}[A-Z]/i.test(candidate)) continue;
      model = candidate;
      break;
    }
  }
  if (model) model = String(model).toUpperCase().replace(/^HX(\d)/, 'HX $1');

  return model ? `${family} ${model}` : family;
}

/* ------------------------------------------------------------------ */
/* GPU                                                                 */
/* ------------------------------------------------------------------ */
function parseGpu(nameSegs, map, fullText) {
  const explicit = pick(map, 'graphics', 'gpu', 'graphics type', 'video card');
  const seg = nameSegs.find((s) => /nvidia|geforce|rtx|gtx|radeon\s+rx|arc\s+a\d/i.test(s));
  const source = [seg, explicit, fullText].filter(Boolean).join(' ');

  // NVIDIA RTX/GTX：只留数字 + Ti/Super，和截图里的风格一致
  // 允许型号和数字之间夹商标符号：Amazon 的标题写成 "GeForce RTX™ 5080"，
  // 不放过 ™/® 的话这类卡的芯片会认不出来（实测漏掉 RTX™ 5080）
  const nv = source.match(/\b(?:RTX|GTX)[™®\s]*(\d{4})\s*(Ti\s*Super|Super|Ti)?/i);
  if (nv) {
    const suffix = nv[2]
      ? ' ' + nv[2].toLowerCase().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      : '';
    return `${nv[1]}${suffix}`;
  }

  const radeon = source.match(/Radeon\s+RX\s*(\d{4}\s?(?:XTX|XT|M)?)/i);
  if (radeon) return `RX ${radeon[1].toUpperCase().replace(/\s+/g, ' ')}`;

  const arc = source.match(/Arc\s+([AB]\d{3}[A-Z]?)/i);
  if (arc) return `Arc ${arc[1].toUpperCase()}`;

  if (/apple\s+m[1-9]|integrated|iris|uhd graphics|radeon graphics|arc graphics|adreno/i.test(source)) {
    return '核显';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 内存                                                                */
/* ------------------------------------------------------------------ */
function parseRam(nameSegs, map, fullText) {
  const sizeRaw =
    pick(map, 'system memory (ram)', 'system memory', 'total installed memory', 'memory') || '';
  const typeRaw = pick(map, 'type of memory (ram)', 'memory type', 'ram type') || '';
  const speedRaw = pick(map, 'memory speed', 'system memory ram speed') || '';

  let gb = firstNum(sizeRaw);
  if (gb && /megabyte|mb/i.test(sizeRaw)) gb = gb / 1024;

  if (!gb) {
    const seg = nameSegs.find((s) => /\d+\s?GB\s+(Memory|RAM|LPDDR|DDR|Unified)/i.test(s));
    const m = (seg || fullText).match(/(\d+)\s?GB\s+(?:Memory|RAM|LPDDR|DDR|Unified)/i);
    if (m) gb = Number(m[1]);
  }
  if (!gb) return null;

  const typeText = [typeRaw, nameSegs.join(' '), fullText].join(' ');
  const tm = typeText.match(/\b(LPDDR5X|LPDDR5|LPDDR4X|LPDDR4|DDR5|DDR4|GDDR6|Unified)\b/i);
  let type = tm ? tm[1].toUpperCase().replace('UNIFIED', 'Unified') : '';

  const speed = firstNum(speedRaw) || (typeText.match(/DDR[45]X?[-\s](\d{4})/i)?.[1] ?? null);
  if (type && speed && /^DDR/.test(type)) type = `${type}-${speed}`;

  return type ? `${Math.round(gb)}G ${type}` : `${Math.round(gb)}G`;
}

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */
function fmtStorage(gb) {
  if (!gb) return null;
  if (gb >= 1000) {
    const tb = gb / 1000;
    return `${Number.isInteger(tb) ? tb : tb.toFixed(1)}T`;
  }
  return `${Math.round(gb)}G`;
}

function parseDisk(nameSegs, map, fullText) {
  const raw =
    pick(map, 'total storage capacity', 'solid state drive capacity', 'hard drive capacity', 'storage') || '';
  let gb = firstNum(raw);
  if (gb && /terabyte|\btb\b/i.test(raw)) gb *= 1000;

  if (!gb) {
    const seg = nameSegs.find((s) => /\d+\s?(GB|TB)\s+(SSD|Storage|PCIe|NVMe|HDD)/i.test(s));
    const m = (seg || fullText).match(/(\d+(?:\.\d+)?)\s?(GB|TB)\s+(?:SSD|Storage|PCIe|NVMe|HDD)/i);
    if (m) gb = Number(m[1]) * (/tb/i.test(m[2]) ? 1000 : 1);
  }
  return fmtStorage(gb);
}

/* ------------------------------------------------------------------ */
/* 显存（只有独立显卡才有意义）                                          */
/* ------------------------------------------------------------------ */
/**
 * 从显卡名里取显存，例如 "16GB GDDR7" → "16G GDDR7"。
 *
 * 为什么不复用 parseRam：它找的是**系统内存**，正则要求
 * `数字GB + (Memory|RAM|LPDDR|DDR|Unified)`，而显卡写的是 "12GB GDDR7" ——
 * GDDR 以 G 开头，匹配不上，所以显卡的 ram 一直是 null。
 * 两者语义也不同（显存 vs 系统内存），混在一个字段里排序和分档都会错。
 */
function parseVram(nameSegs, map, fullText) {
  const explicit = pick(map, 'video memory', 'graphics memory', 'memory size');
  const src = [explicit, nameSegs.join(' '), fullText].filter(Boolean).join(' ');
  const m = src.match(/(\d{1,2})\s?GB\s+(GDDR\d[X]?|HBM\d?)/i);
  if (m) return `${m[1]}G ${m[2].toUpperCase()}`;
  // 退一步：MSI 那种 "5070 12G GAMING TRIO" 型号里的容量标注
  const bare = src.match(/\b(\d{1,2})\s?GB?\b(?=\s|$)/i);
  return bare && Number(bare[1]) <= 48 ? `${bare[1]}G` : null;
}

/* ------------------------------------------------------------------ */
/* CPU / 内存 / 硬盘 —— 散装配件专用                                     */
/* ------------------------------------------------------------------ */

/**
 * 为什么不复用 parseRam / parseDisk：那两个是给**整机**写的，要求容量后面
 * 紧跟关键词（`\d+GB\s+(Memory|RAM|SSD|…)`）。而裸条/裸盘中间夹着别的词：
 *   "memory 16gb 288-pin pc ram ddr4 2400"   ← 16gb 后面是 288-pin
 *   "990 PRO 2TB Internal SSD PCle Gen 4x4"  ← 2TB 后面是 Internal
 * 实测这两种整机正则一个都匹配不上，所以配件另走一套。
 */

const CORE_WORDS = { quad: 4, hexa: 6, octa: 8, deca: 10, dodeca: 12, hexadeca: 16 };

/** CPU 核心数。写法五花八门：8-Core / 12-core, / 12C 24T / Hexadeca-core */
function parseCores(fullText) {
  const t = String(fullText);
  const m = t.match(/\b(\d{1,3})\s*[-\s]?core\b/i);
  if (m && Number(m[1]) <= 256) return Number(m[1]);
  const w = t.match(/\b(quad|hexa|octa|deca|dodeca|hexadeca)[-\s]?core\b/i);
  if (w) return CORE_WORDS[w[1].toLowerCase()] ?? null;
  const c = t.match(/\b(\d{1,3})c\s*\/?\s*\d{1,3}t\b/i);
  return c ? Number(c[1]) : null;
}

/** CPU 插槽。同插槽才谈得上互换，是同档分组的关键维度。 */
function parseSocket(fullText) {
  const t = String(fullText);
  const m = t.match(/\bsocket\s?(am\d\+?|fm\d\+?|tr\d)\b/i) || t.match(/\b(lga\s?\d{3,4})\b/i);
  return m ? m[1].toUpperCase().replace(/\s+/g, ' ') : null;
}

/** 裸内存条：容量 + 类型/频率，例如 "16G DDR4-2400" */
function parseRamStick(fullText) {
  const t = String(fullText);
  const cap = t.match(/\b(\d{1,3})\s?GB?\b/i);
  if (!cap || Number(cap[1]) > 512) return null;
  const type = t.match(/\b(DDR[345]|LPDDR[45]X?)\b/i);
  // 频率有两种写法："ddr4 2400" 和 "(pc4 19200)"，取前者
  const spd = t.match(/\bDDR[345]X?[-\s](\d{4})\b/i);
  let out = `${cap[1]}G`;
  if (type) out += ` ${type[1].toUpperCase()}`;
  if (type && spd) out += `-${spd[1]}`;
  return out;
}

/** 裸盘容量（统一成 GB 数） */
function parseDriveGb(fullText) {
  const t = String(fullText);
  const tb = t.match(/\b(\d{1,2}(?:\.\d)?)\s?TB\b/i);
  if (tb) return Number(tb[1]) * 1000;
  const gb = t.match(/\b(\d{3,4})\s?GB\b/i);
  return gb ? Number(gb[1]) : null;
}

/** 盘的接口。NVMe 和 SATA 是完全不同的价位段，必须分开比。 */
function parseDriveBus(fullText) {
  const t = String(fullText);
  // Best Buy 有时把 PCIe 拼成 PCle（大写 i 和小写 L 撞脸），两种都认
  if (/\bnvme\b|pc[il]e?\s*gen\s*\d/i.test(t)) return 'NVMe';
  if (/\bsata\b/i.test(t)) return 'SATA';
  if (/\bhdd\b|hard drive/i.test(t)) return 'HDD';
  return null;
}

/* 显卡型号短名要去掉的噪声：芯片型号自己有一列，别在型号里重复一遍。 */
const GPU_NOISE = [
  /\b(?:nvidia|amd|intel)\b/gi,
  /\bgeforce\b|\bradeon\b|\barc\b/gi,
  /\b(?:RTX|GTX|RX)\s*\d{3,4}\s*(?:Ti\s*Super|Super|Ti|XTX|XT)?/gi,
  // 接口要在容量之前删：不然 "PCI Express Gen 5" 里的 5 被容量规则吃掉后，
  // 剩下的 "PCI Express Gen" 就再也匹配不上了
  /\bPCI\s*Express\s*(?:Gen\s*)?[\d.]+(?:\s*x\d+)?/gi,
  // 容量里的 G 必须紧跟数字。写成 \d{1,2}\s?GB? 的话，"Gen 5 Graphics" 中的
  // "5 G" 会被当成容量吃掉，把 Graphics 啃成 raphics（踩过）。
  /\b\d{1,2}GB?\b\s*(?:GDDR\d[X]?|HBM\d?)?/gi,
  // 容量和类型之间夹了别的词时（"16GB OC GDDR7"）类型会落单，单独再扫一遍
  /\b(?:GDDR\d[X]?|HBM\d?)\b/gi,
  /\bgraphics card\b|\bvideo card\b/gi,
  /\bwith\b.*$/i,
  // 颜色：整机走 segs[1] 天然不含颜色，配件用的是全名，得自己剥
  /\s*[-–—]\s*(?:black|white|silver|gray|grey|blue|red|green|pink)\s*$/gi,
  /[-–—,]\s*$/,
];

/* CPU / 内存 / 硬盘的短名噪声。同理：规格自己有列，型号里别重复。 */
const CPU_NOISE = [
  /\b(?:amd|intel)\b/gi,
  /\b\d{1,3}\s*[-\s]?core\b|\b(?:quad|hexa|octa|deca|dodeca|hexadeca)[-\s]?core\b/gi,
  /\b\d{1,3}\s*[-\s]?thread\b/gi,
  /\b\d{1,3}c\s*\/?\s*\d{1,3}t\b/gi,
  /\bsocket\s?(?:am\d\+?|fm\d\+?|tr\d)\b|\blga\s?\d{3,4}\b/gi,
  /\([^)]*(?:boost|turbo|ghz)[^)]*\)/gi,
  /\b[\d.]+\s?GHz(?:\s*\/\s*[\d.]+\s?GHz)?/gi,
  /\b\d{1,3}W\b/gi,
  /\b\d{1,3}MB\b/gi,
  /\bdesktop processor\b|\bprocessor\b|\bcpu\b|\bretail\b|\bunlocked\b/gi,
  /[-–—,]\s*$/,
];
const RAM_NOISE = [
  /\b\d{1,3}\s?GB?\b/gi,
  /\b(?:LP)?DDR[345]X?(?:[-\s]\d{4})?\b/gi,
  /\bpc[45]\s?\d{4,5}\b/gi,
  /\(\s*pc[45][^)]*\)/gi,
  /\b\d{3}-pin\b|\b(?:so)?dimm\b|\budimm\b/gi,
  /\bdesktop memory\b|\bmemory ram\b|\bmemory\b|\bram\b|\bmodule\b|\bkit\b/gi,
  /[-–—,]\s*$/,
];
const SSD_NOISE = [
  /\b\d{1,2}(?:\.\d)?\s?TB\b|\b\d{3,4}\s?GB\b/gi,
  /\bnvme\b|\bsata(?:\s?iii)?\b|\bpc[il]e?\s*(?:gen\s*)?[\d.]+(?:\s*x\d+)?\b/gi,
  /\bm\.?2\s?\d{4}\b|\b\d(?:\.\d)?"\b/gi,
  /internal\s+(?:\w+\s+){0,2}(?:ssd|hard drive|solid state)/gi,
  /\bssd\b|\bhard drive\b|\bsolid state\b|\bfor desktops?\b|\b\d{3}MB cache\b/gi,
  /[-–—,]\s*$/,
];

const PART_NOISE = { gpu: GPU_NOISE, cpu: CPU_NOISE, ram: RAM_NOISE, ssd: SSD_NOISE };

/* 四类配件都要剥的：总线/接口、颜色后缀。放通用表里免得每类各写一遍还漏。 */
const COMMON_PART_NOISE = [
  /\bPC[Il]e?\s*(?:Express\s*)?(?:Gen\s*)?[\d.]+(?:\s*x\d+)?/gi,
  /\s*[-–—]?\s*\b(?:black|white|silver|gray|grey|blue|red|green|pink|titanium)\b\s*$/gi,
];

function shortComponentName(brand, fullName, form) {
  let s = fullName || '';
  for (const re of [...(PART_NOISE[form] || []), ...COMMON_PART_NOISE]) s = s.replace(re, ' ');
  // 品牌已经单独一列
  if (brand) s = s.replace(new RegExp(`^\\s*${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-–—]?`, 'i'), ' ');
  // 剥掉空括号和残余标点。内存这类"通用模块"往往没有型号名，剥完只剩
  // "pc ( ) mo" 这种残渣，硬当型号显示反而更糊涂 —— 那就老实说没有，
  // 让界面退回显示品牌 + 规格（规格本身就是这类商品的身份）。
  s = s
    .replace(/\(\s*\)/g, ' ')
    .replace(/[()\[\]]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.–—-]+|[\s,.–—-]+$/g, '')
    .trim();
  // 去掉清洗后剩下的孤立短词（"pc"、"mo" 之类被切断的尾巴）
  s = s.split(/\s+/).filter((w) => w.length >= 3 || /^\d+$/.test(w)).join(' ');
  const letters = (s.match(/[a-z0-9]/gi) || []).length;
  return letters >= 3 ? s.slice(0, 40) : null;
}

/* ------------------------------------------------------------------ */
/* 重量 / 屏幕                                                          */
/* ------------------------------------------------------------------ */
function parseWeight(map) {
  const raw = pick(map, 'product weight', 'weight');
  if (!raw) return null;
  const n = firstNum(raw);
  if (!n) return null;
  let kg;
  if (/kilogram|\bkg\b/i.test(raw)) kg = n;
  else if (/ounce|\boz\b/i.test(raw)) kg = (n / 16) * LB_TO_KG;
  else kg = n * LB_TO_KG; // Best Buy 默认磅
  if (kg <= 0 || kg > 60) return null;
  return `${kg.toFixed(1)}kg`;
}

function parseScreen(nameSegs, map, fullText) {
  const raw = pick(map, 'screen size', 'screen size (measured diagonally)', 'display size');
  let inches = firstNum(raw);
  if (!inches) {
    const m = (nameSegs[1] || fullText).match(/\b(\d{2}(?:\.\d)?)["”]|\b(\d{2}(?:\.\d)?)[-\s]inch/i);
    if (m) inches = Number(m[1] || m[2]);
  }
  if (!inches || inches < 10 || inches > 50) return null;

  const hzText = [nameSegs.join(' '), fullText, pick(map, 'refresh rate') || ''].join(' ');
  const hz = hzText.match(/(\d{2,3})\s?Hz/i)?.[1];
  const panel = /\bOLED\b/i.test(hzText) ? 'OLED' : /\bMini[-\s]?LED\b/i.test(hzText) ? 'miniLED' : '';

  let out = `${inches}"`;
  if (panel) out += ` ${panel}`;
  if (hz && Number(hz) >= 90) out += ` ${hz}Hz`;
  return out;
}

/* ------------------------------------------------------------------ */
/* 型号短名                                                             */
/* ------------------------------------------------------------------ */
const NOISE = [
  // 品相前缀由 condition 字段单独展示，不用挤在型号里
  /\b(certified\s+)?(refurbished|renewed|open[-\s]?box|pre[-\s]?owned)\b/gi,
  // 注意不要吃掉 "tower"：Legion Tower 7i 这类型号里它是名字的一部分
  /\b(gaming|business|everyday|gaming\/entertainment)?\s*(laptop|notebook|desktop|all-in-one|aio|pc|computer)\b/gi,
  /\b(touch[-\s]?screen|touchscreen|thin and light|2-in-1)\b/gi,
  // 尺寸：结尾不能用 \b，因为引号后面通常是空格（两边都不是词字符）
  /\b\d{2}(?:\.\d)?\s?(?:["”]|inch(?:es)?\b)/gi,
  /\b\d{2,3}\s?Hz\b/gi,
  /\b(Full|Ultra)\s+HD\b/gi,
  /\b(FHD\+?|QHD\+?|UHD|WUXGA|WQXGA|WQUXGA|WUHD|1080p|1440p|HD)\b/gi,
  /\b\d(?:\.\d)?K\b/gi,                            // 2K / 2.5K / 3K / 4K 分辨率标注
  /\b\d{1,2}[-\s]?Cores?\b/gi,
  /\b(OLED|IPS|LED|LCD|Mini[-\s]?LED|AMOLED|Touch)\b/gi,
  /\bwith\b.*$/i,
  /[-–—,]\s*$/,
];

function shortModel(brand, seg, fullName) {
  const raw = seg || fullName || '';
  let s = raw;
  for (const re of NOISE) s = s.replace(re, ' ');
  s = s.replace(/\s{2,}/g, ' ').replace(/^[\s,–—-]+|[\s,–—-]+$/g, '').trim();
  if (brand && s.toLowerCase().startsWith(brand.toLowerCase())) {
    s = s.slice(brand.length).replace(/^[\s-]+/, '');
  }
  // 清洗把整段都吃光了（比如 "15.3" 2K Gaming Laptop"），退回未清洗的那一段，
  // 而不是退回整个超长商品名——表格列放不下。
  if (s.length < 3) return raw.trim().slice(0, 40);
  return s;
}

function parseYear(fullText, map) {
  const rel = pick(map, 'release year', 'model year');
  const y = firstNum(rel);
  if (y && y >= 2015 && y <= 2035) return String(y);
  const m = fullText.match(/\b(20[2-3]\d)\b/);
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------ */
/* 机型判定                                                             */
/* ------------------------------------------------------------------ */
/**
 * 配件（单件硬件）的识别锚点。
 *
 * **必须在整机之前判定**，因为配件名字里普遍把 "Desktop"/"Laptop" 当兼容性描述用：
 *   "AMD - Ryzen 5 5500 6-Core … Socket AM4 Processor"        ← 含 Processor
 *   "Black Diamond - memory 16gb 288-pin pc ram ddr4 … desktop memory"
 *   "WD - Blue 6TB PC Internal Hard Drive for Desktops"
 * 原来的 /desktop|tower|…/ 会把这三种全认成台式机。
 *
 * 反过来也得防：锚点必须是配件**独有**的，不能把整机抢过来。
 * 踩过的具体教训 ——
 *  · `\bprocessor\b` 不能用：242 台真电脑里有 16 台名字含 "Intel Processor N150"
 *  · `M.2 2280` 不能用：整机也写（"Acer Aspire XC … 512GB M.2 2280 PCIe"）
 *  · `\bmemory\b` 不能用：几乎每台整机都写 "16GB Memory"
 * 所以只留下 socket 型号、针脚数、DIMM、"Internal SSD" 这类产品名词。
 */
const COMPONENT_PATTERNS = [
  ['gpu', /graphics card|video card/],
  [
    'cpu',
    new RegExp(
      [
        'socket\\s?(?:am\\d|fm\\d|lga)',
        // 裸插槽名（没有 Socket 前缀）："… oc am4 tray processor" / "sTR5 350W"
        // 实测 258 台整机 0 误伤
        '\\b(?:am[45]\\+?|str[45]|fm2\\+?)\\b',
        'lga[-\\s]?\\d{3,4}',
        '\\bdesktop processor\\b',            // 产品名词，整机不会这么写
        '\\b(?:tray|boxed)\\s+processor\\b',  // 散片/盒装，整机 0 误伤
        '\\d+[-\\s]?core\\s*[-–,]?\\s*\\d+[-\\s]?thread',   // 12-core - 24-thread / 12-core, 24-thread
        '\\b\\d{1,2}c\\s*\\/?\\s*\\d{1,2}t\\b',             // EPYC 那种 "12C 24T" 简写
        '\\b(?:hexa|octa|deca|dodeca|hexadeca|quad)[-\\s]?core\\b',
        // 英文词形核心数（"Eight-Core"），整机 0 误伤
        '\\b(?:eight|nine|ten|twelve|sixteen|twenty|twentyfour)[-\\s]?core\\b',
        // 核心数 + processor 同时出现。**不能只用裸 N-core** ——
        // 实测误伤 14 台整机（"Snapdragon X (8-Core CPU)" 这类）。
        '\\b\\d{1,3}\\s?-?core\\b[\\s\\S]*\\bprocessor\\b',
      ].join('|')
    ),
  ],
  ['ram', /\d{3}-pin|\bdimm\b|\bpc[45]\b|\bmemory ram\b|\budimm\b|\bsodimm\b/],
  [
    'ssd',
    new RegExp(
      [
        // "Internal Gaming Hard Drive" 中间会插形容词，允许隔一两个词
        'internal\\s+(?:\\w+\\s+){0,2}(?:ssd|hard drive|solid state)',
        // 裸盘的名字是「品牌 - 容量 型号」，容量紧跟品牌；整机一定先写型号名。
        // 实测：这个形态在 242 台整机里 0 命中，而 "nvme ssd"（紧邻）和
        // "m.2 2280" 各命中 1 台整机，所以那两个都不能用。
        '^[a-z ]+-\\s*\\d+(?:tb|gb)\\b(?=.*(?:ssd|nvme|hard drive|solid state))',
      ].join('|')
    ),
  ],
];

export function classifyForm(product, map) {
  const t = `${product.name} ${product.category || ''} ${pick(map, 'product type') || ''}`.toLowerCase();

  // 配件优先，理由见 COMPONENT_PATTERNS 上面的注释
  for (const [form, re] of COMPONENT_PATTERNS) if (re.test(t)) return form;

  if (/all[-\s]?in[-\s]?one|\baio\b/.test(t)) return 'aio';
  if (/desktop|tower|mini pc|\bnuc\b|workstation/.test(t)) return 'desktop';
  if (/laptop|notebook|macbook|chromebook|ultrabook|2-in-1/.test(t)) return 'laptop';
  // 显示器放在整机之后：整机名字里的分辨率/尺寸不会带 monitor 这个词
  if (/\bmonitor\b|\bdisplay\b.*\b(?:hz|ips|va panel)\b/.test(t)) return 'monitor';
  if (/tablet|ipad/.test(t)) return 'tablet';
  return 'other';
}

/** 单件硬件（配件），和整机相对 */
export const COMPONENT_FORMS = new Set(['gpu', 'cpu', 'ram', 'ssd', 'monitor']);

export function isComponent(specs) {
  return COMPONENT_FORMS.has(specs?.form);
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */
export function extractSpecs(product) {
  const map = detailMap(product.details);
  const fullName = product.name || '';
  const segs = fullName.split(/\s+[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
  const detailText = [...map.entries()].map(([k, v]) => `${k}: ${v}`).join(' | ');
  const fullText = `${fullName} | ${detailText}`;

  const brand = product.manufacturer || (segs.length > 1 ? segs[0] : null);
  const year = parseYear(fullText, map);
  // form 要在算型号短名之前定下来 —— 配件和整机的清洗规则不一样
  // （显卡的芯片型号自己有一列，不该再挤在型号里重复一遍）
  const form = classifyForm(product, map);
  const isPart = COMPONENT_FORMS.has(form);
  // 配件清洗不出型号时**不要**回退到整机那套 —— 整机逻辑会把原始长名截一段
  // 当型号（"memory 16gb 288-pin ram ddr4 2933 (pc4…"），比留空更糊涂。
  // 通用内存条这类本来就没有型号名，规格本身就是它的身份，交给界面显示品牌+规格。
  const model = isPart
    ? shortComponentName(brand, fullName, form)
    : shortModel(brand, segs.length > 1 ? segs[1] : segs[0], fullName);
  let cpu = parseCpu(segs, map, fullText);
  let gpu = parseGpu(segs, map, fullText);
  let gpuInferred = false;

  // Apple 芯片是 SoC，没有独显这一说
  if (!gpu && cpu && /^M[1-9]/.test(cpu)) gpu = '核显';

  // 电脑类商品，名字和参数里翻遍了都没有独显关键词 —— 那就是核显机。
  // Best Buy 的商品名只要有独显必写（"NVIDIA GeForce RTX 5070"），
  // 所以"没写"是很强的信号。标成推断值，别和明确识别出来的混为一谈。
  if (!gpu && (form === 'laptop' || form === 'desktop' || form === 'aio')) {
    gpu = '核显';
    gpuInferred = true;
  }

  // 标题混乱时（多见于第三方卖家），显卡型号会被当成 CPU 编号：i7 5060。
  // CPU 编号和显卡型号撞号就说明认错了，只保留家族名。
  if (cpu && gpu) {
    const gpuNum = String(gpu).match(/\d{4}/)?.[0];
    const cpuNum = cpu.split(/\s+/)[1];
    if (gpuNum && cpuNum === gpuNum) cpu = cpu.split(/\s+/)[0];
  }

  return {
    brand: brand || null,
    model: isPart ? model : model || fullName,
    year,
    // 截图里的紧凑标题：型号 + 年份
    // 型号里已经带了年份就别再拼一次（"Yoga Slim 7x 2026 2026"），
    // 再截个长度，免得第三方卖家那种一长串关键词标题把表格撑爆
    shortName: (() => {
      // 配件解析不出型号就给 null，别回退成原始长名（界面会显示品牌+规格）；
      // 也不给配件拼年份 —— 一条内存的"2025"没有意义
      if (isPart) return model ? (model.length > 46 ? model.slice(0, 45).trimEnd() + '…' : model) : null;
      const base = model || fullName;
      const withYear = year && !base.includes(year) ? `${base} ${year}` : base;
      return withYear.length > 46 ? withYear.slice(0, 45).trimEnd() + '…' : withYear;
    })(),
    cpu,
    gpu,
    gpuInferred,
    // 显存：只有独立显卡这类配件才填，整机的"显存"没意义也解析不到
    vram: form === 'gpu' ? parseVram(segs, map, fullText) : null,
    // 散装 CPU 才有核心数和插槽；整机的"核心数"不是买点，插槽更无从谈起
    cores: form === 'cpu' ? parseCores(fullText) : null,
    socket: form === 'cpu' ? parseSocket(fullText) : null,
    // 盘的接口：NVMe 和 SATA 是完全不同的价位段，必须分开比
    bus: form === 'ssd' ? parseDriveBus(fullText) : null,
    // 裸条/裸盘走配件解析，整机仍走原来的（两者正则要求不同，见上面注释）
    ram: form === 'ram' ? parseRamStick(fullText) || parseRam(segs, map, fullText) : parseRam(segs, map, fullText),
    disk: form === 'ssd' ? fmtStorage(parseDriveGb(fullText)) || parseDisk(segs, map, fullText) : parseDisk(segs, map, fullText),
    weight: parseWeight(map),
    screen: parseScreen(segs, map, fullText),
    form,
    // Best Buy 自营商品名一律是 "品牌 - 型号 - 规格 - 规格…"，第一段是个短品牌名。
    // 第三方卖家(Marketplace)的标题通常是一坨堆砌的关键词，用这个粗略区分。
    structured: segs.length >= 3 && segs[0].length <= 25,
  };
}

/**
 * 只保留电脑（笔电/台式/一体机）。用户要的就是这块。
 */
export function isComputer(specs) {
  return specs.form === 'laptop' || specs.form === 'desktop' || specs.form === 'aio';
}

export const FORM_LABEL = {
  laptop: '笔电',
  desktop: '台式',
  aio: '一体机',
  tablet: '平板',
  other: '其它',
};
