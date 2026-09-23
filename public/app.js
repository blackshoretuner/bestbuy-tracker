/* =========================================================
   Best Buy 降价雷达 — 前端
   ========================================================= */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  tab: 'board',
  settings: null,
  status: null,
  categories: [],
  searches: [],
  board: [],
  boardFilters: { q: '', form: 'all', condition: 'all', retailer: 'all', maxPrice: '', onlyDrops: false, inStock: false, trueDeal: false, sort: 'deal' },
  hwFilters: { q: '', form: 'all', retailer: 'all', maxPrice: '', inStock: false, sort: 'deal' },
  evFilters: { q: '', type: 'drop,target', since: '', sort: 'recent' },
  editingSearch: null,
};

/* ---------------- 基础 ---------------- */
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = { ok: false, error: `HTTP ${res.status}` }; }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toastMsg ${kind}`;
  el.textContent = msg;
  $('#toastHost').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(14px)';
    setTimeout(() => el.remove(), 300);
  }, kind === 'err' ? 6000 : 3200);
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (n) => (n === null || n === undefined ? '—' : Number(n).toFixed(2));
const dash = (v) => (v === null || v === undefined || v === '' ? '<span style="color:var(--fg-mute)">·</span>' : esc(v));

function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  if (d < 604800000) return `${Math.floor(d / 86400000)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function stamp(ts) {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  const t = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return today ? t : `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}

/**
 * 变价事件的时间单元：旧价起于 → 降价发现，和价格列的 旧价→新价 一一对应。
 *
 * 左边**不是**"上次查询的时间"——那永远只差一个轮询间隔（现在是 10 分钟），
 * 满屏都是同一个数字，没有信息量。左边是**旧价开始挂出的时间**，
 * 所以能一眼看出"这个价挂了多久才降"。
 *
 * 真正的降价发生在这两个时间之间的某一刻，我们只知道这个区间 —— tooltip 里讲明。
 */
function timeCell(e) {
  const dim = 'color:var(--fg-mute)';
  if (!e.prevTs) return `<td class="mono" style="${dim}">${stamp(e.ts)}</td>`;

  const a = new Date(e.prevTs);
  const b = new Date(e.ts);
  const md = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // 同一天就不重复写日期，省一截宽度
  const sameDay = a.toDateString() === b.toDateString();
  const from = `${md(a)} ${hm(a)}`;
  const to = sameDay ? hm(b) : `${md(b)} ${hm(b)}`;

  const ms = e.ts - e.prevTs;
  const held = ms >= 86400000 ? `${(ms / 86400000).toFixed(1)} 天` : `${Math.round(ms / 3600000)} 小时`;
  const title =
    `$${money(e.prevPrice)} 从 ${from} 起挂着（约 ${held}）\n` +
    `${sameDay ? md(b) + ' ' + to : to} 这轮查到降为 $${money(e.price)}\n` +
    `实际调价发生在这两个时间之间`;

  return `<td class="mono tspan" title="${esc(title)}"><span class="was">${from}</span><span class="arrow">→</span><span class="now">${to}</span></td>`;
}

/* 品相徽标 */
function condBadge(condition) {
  if (!condition || /^new$/i.test(condition)) return '';
  if (/open-?box/i.test(condition)) {
    const grade = condition.match(/\(([^)]+)\)/)?.[1] || '';
    return `<span class="badge ob" title="${esc(condition)}">拆封${grade ? ' ' + esc(grade.replace(/excellent/i, '优').replace(/certified/i, '认证').replace(/satisfactory/i, '良').replace(/fair/i, '可')) : ''}</span>`;
  }
  if (/refurb/i.test(condition)) return '<span class="badge used">官翻</span>';
  if (/pre-?owned|used/i.test(condition)) return '<span class="badge used">二手</span>';
  return `<span class="badge used">${esc(condition)}</span>`;
}

/* 价格单元：原价 → 现价 */
function priceCell(regular, now, extraClass = '') {
  const hasWas = regular != null && now != null && regular > now;
  const cls = ['price', hasWas ? 'deal' : '', extraClass].filter(Boolean).join(' ');
  if (!hasWas) return `<td class="${cls}"><span class="now">${money(now)}</span></td>`;
  return `<td class="${cls}"><span class="was">${money(regular)}</span><span class="arrow">→</span><span class="now">${money(now)}</span></td>`;
}

function offCell(pct) {
  const p = Number(pct);
  if (!p || Math.abs(p) < 0.05) return '<td class="off zero">—</td>';
  // 小于 1% 的时候 "-0%" 很难看，补一位小数
  const txt = Math.abs(p) < 1 ? Math.abs(p).toFixed(1) : Math.abs(p).toFixed(0);
  return p > 0 ? `<td class="off on">-${txt}%</td>` : `<td class="off up">+${txt}%</td>`;
}

/**
 * 分位单元格。两列共用：数字越小越划算，用色阶表达。
 * 算不出来就明明白白显示 "—"，鼠标悬停给原因，不糊弄。
 */
function pctCell(pct, title) {
  if (pct == null) return `<td class="pct na" title="${esc(title || '数据不足')}">—</td>`;
  const bucket = pct <= 10 ? 'p0' : pct <= 30 ? 'p1' : pct <= 60 ? 'p2' : pct <= 85 ? 'p3' : 'p4';
  return `<td class="pct ${bucket}" title="${esc(title || '')}">${pct}</td>`;
}

/* 零售商的显示名。内部一律用小写 id（bestbuy/bh），显示分开管，改文案不动数据。 */
const SHOP_LABEL = { bestbuy: 'Best Buy', bh: 'B&H', amazon: 'Amazon' };
const shopLabel = (id) => SHOP_LABEL[id] || id || '?';

function crossTitle(cross) {
  if (!cross) return '同档：样本不足，没法横向比';
  const bits = [
    `同档 [${cross.label}] 共 ${cross.n} 台，本机第 ${cross.rank} 便宜`,
    `同档最低 $${money(cross.min)}，中位 $${money(cross.median)}`,
  ];
  if (cross.vsMedian != null) {
    bits.push(cross.vsMedian <= 0 ? `比中位便宜 $${money(-cross.vsMedian)}` : `比中位贵 $${money(cross.vsMedian)}`);
  }
  if (cross.cheaper?.length) {
    // 带上商家：跨零售商比价时，"便宜的那个在哪家"才是能直接拿去用的信息
    bits.push(
      '同档更便宜的：' +
        cross.cheaper.map((c) => `${shopLabel(c.retailer)} ${c.name} $${money(c.price)}`).join('、')
    );
  }
  return bits.join('\n');
}

function histTitle(hist) {
  if (!hist) return '';
  if (!hist.enough) return `历史分位：${hist.reason}`;
  return [
    `过去 ${hist.days} 天里，只有 ${hist.pct}% 的时间价格低于或等于现在`,
    `区间 $${money(hist.min)} ~ $${money(hist.max)}，${hist.levels} 个价位`,
    hist.pct <= 10 ? '→ 处于历史低位' : hist.pct >= 85 ? '→ 处于历史高位，别急' : '',
  ].filter(Boolean).join('\n');
}

/* 真正破纪录才算新低：至少跟踪过 3 轮，且跌破了上一个低点 */
function isNewLow(r) {
  return (
    r.seenCount >= 3 &&
    r.price != null &&
    r.prevMinPrice != null &&
    r.price < r.prevMinPrice &&
    r.lastDropAt &&
    Date.now() - r.lastDropAt < 7 * 86400000
  );
}

/* ---------------- 标签页 ---------------- */
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  state.tab = btn.dataset.tab;
  $$('.tab').forEach((t) => t.classList.toggle('active', t === btn));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${state.tab}`));
  refreshTab();
});

function refreshTab() {
  if (state.tab === 'board') loadBoard();
  else if (state.tab === 'hardware') loadHardware();
  else if (state.tab === 'history') loadEvents();
  else if (state.tab === 'watch') loadWatch();
  else if (state.tab === 'searches') renderSearches();
  else if (state.tab === 'settings') { fillSettings(); loadLogs(); loadAlerts(); }
}

/* ---------------- 电脑榜 ---------------- */
async function loadBoard() {
  const f = state.boardFilters;
  const qs = new URLSearchParams({
    q: f.q, form: f.form, condition: f.condition, retailer: f.retailer, sort: f.sort,
    onlyDrops: f.onlyDrops ? '1' : '0',
    inStock: f.inStock ? '1' : '0',
    trueDeal: f.trueDeal ? '1' : '0',
    limit: '400',
  });
  if (f.maxPrice) qs.set('maxPrice', f.maxPrice);

  try {
    const data = await api(`/api/board?${qs}`);
    state.board = data.rows;
    state.boardStats = data.stats || {};
    $('#cntBoard').textContent = data.total;
    // 把"多少台攒够历史了"摆出来，否则用户只看到一片"—"会以为坏了
    const st = data.stats || {};
    $('#boardCount').textContent =
      `${data.rows.length} / ${data.total} 台` +
      (data.total ? ` · 同档可比 ${st.withCross ?? 0} · 有历史 ${st.withHist ?? 0} · 真好价 ${st.trueDeals ?? 0}` : '') +
      (st.hiddenThirdParty ? ` · 已隐藏三方 ${st.hiddenThirdParty}` : '') +
      (st.soldOut ? ` · 已售罄 ${st.soldOut}` : '');

    // 重量列：整榜一台都没有就收起来。网页通道永远取不到（重量只在详情页），
    // 留一整列 "·" 纯粹白占表格宽度；哪天换成 API 通道有数据了它会自己回来。
    applyShopColumn(st.retailers, $('#boardTable'), '#fBoardShop', state.boardFilters);
    if (applyWeightColumn((st.withWeight ?? 0) > 0)) return loadBoard();

    // 历史分位要靠时间攒。一列全是"—"很容易被当成坏了，直接讲明白。
    const hint = $('#boardHint');
    if (data.total && !st.withHist) {
      hint.hidden = false;
      hint.innerHTML =
        '「历史」列还是空的：需要至少 <b>3 天</b>的跟踪、并且价格<b>确实变动过</b>才算得出分位。' +
        '在那之前先看「同档」—— 那一列现在就能用。';
    } else {
      hint.hidden = true;
    }
    renderBoard(data.rows);
  } catch (e) {
    toast(e.message, 'err');
  }
}

/**
 * 重量列的显隐。th 和 td 共用 .w-wt，所以在表上切一个 class 就够了。
 * @returns true 表示排序键失效、需要调用方重新拉一次
 */
function applyWeightColumn(has) {
  $('#boardTable').classList.toggle('noWeight', !has);
  const opt = $('#fBoardSort option[value="weight"]');
  if (opt) opt.hidden = !has;
  // 正按「最轻」排着、这一列却没数据 —— 那个排序等于把所有机器都当成同一个
  // 权重，出来的顺序看着像随机跳。退回默认排序并重新拉一次。
  if (!has && state.boardFilters.sort === 'weight') {
    state.boardFilters.sort = 'deal';
    $('#fBoardSort').value = 'deal';
    return true;
  }
  return false;
}

/**
 * 榜单空态。和历史记录那边同一个道理：「一台都没有」和「筛选没命中」
 * 是两回事，混成一句"榜上还没有机器"会让人以为程序坏了。
 */
function emptyBoardMessage() {
  const f = state.boardFilters;
  const st = state.boardStats || {};

  if (f.trueDeal) {
    return (
      `<b>当前没有「真好价」</b>` +
      `真好价的门槛是：自身历史分位 ≤15%（对它自己来说很便宜）<b style="color:var(--fg-dim)">并且</b>同档分位 ≤35%（对同配置也不贵）。<br>` +
      (st.withHist
        ? `现在 ${st.withHist} 台攒够了历史，但没有一台同时满足两个条件 —— 说明确实没到该出手的时候。`
        : `目前还没有任何一台攒够历史（需要 ≥3 天且价格变动过），所以这个条件必然为空。<br>先用「同档最便宜」排序，那个现在就能用。`)
    );
  }

  const filtered = f.q || f.onlyDrops || f.maxPrice || f.form !== 'all' || f.condition !== 'all' || f.retailer !== 'all';
  if (filtered) {
    return `<b>当前筛选没有命中</b>榜上共 ${$('#cntBoard').textContent} 台，放宽条件再试试`;
  }

  // 全被「隐藏第三方卖家」挡掉的时候，说"榜上还没有机器"就是误导。
  // 这个坑在历史记录页和电脑榜各踩过一次了，别再踩第三次。
  if (st.hiddenThirdParty) {
    return (
      `<b>榜上的机器都被「隐藏第三方卖家」挡住了</b>` +
      `${st.hiddenThirdParty} 台 Marketplace 第三方卖家的商品已隐藏，自营的一台都还没收到。<br>` +
      `去「设置 → 数据源」取消勾选，或者等下一轮查询收进自营商品`
    );
  }

  return state.browser
    ? `<b>榜上还没有机器</b>点右上角的 <code>立即查询</code> 跑一轮（第一次要开浏览器，约 1 分钟）<br>或去「自动搜索」调整搜索条件`
    : `<b>没找到 Edge 或 Chrome</b>浏览器通道需要本机有其中之一。装好后重启本软件即可`;
}

function renderBoard(rows) {
  const body = $('#boardBody');
  const empty = $('#boardEmpty');

  if (!rows.length) {
    body.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = emptyBoardMessage();
    return;
  }
  empty.hidden = true;

  const fresh = Date.now() - 86400000;
  body.innerHTML = rows.map((r) => {
    const s = r.specs || {};
    const dropped = r.lastDropAt && r.lastDropAt > fresh;
    const isLow = isNewLow(r);
    const title = [
      r.name,
      r.prevPrice != null && r.prevPrice !== r.price ? `上次 $${money(r.prevPrice)}` : '',
      r.minPrice != null ? `跟踪最低 $${money(r.minPrice)}` : '',
      `首次发现 ${relTime(r.firstSeenAt)}`,
      crossTitle(r.cross),
      histTitle(r.hist),
    ].filter(Boolean).join('  ·  ');

    return `<tr class="${[dropped ? 'hit' : '', r.deal?.trueDeal ? 'trueDeal' : '', r.inStock === false ? 'oos' : ''].filter(Boolean).join(' ')}" title="${esc(title)}">
      <td class="mono">${esc(r.sku)}</td>
      <td class="w-shop shop">${esc(shopLabel(r.retailer))}</td>
      <td class="name"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(s.shortName || r.name)}</a>${condBadge(r.condition)}${r.thirdParty ? '<span class="badge third" title="Best Buy Marketplace 第三方卖家，退换货政策和自营不同">三方</span>' : ''}${isLow ? '<span class="badge low">新低</span>' : ''}${r.inStock === false ? '<span class="badge oos">缺货</span>' : ''}</td>
      <td class="left">${dash(s.cpu)}</td>
      <td>${dash(s.gpu)}</td>
      <td>${dash(s.ram)}</td>
      <td>${dash(s.disk)}</td>
      <td>${dash(s.screen)}</td>
      <td class="w-wt">${dash(s.weight)}</td>
      ${priceCell(r.regularPrice, r.price)}
      ${offCell(r.percentOff)}
      ${pctCell(r.cross?.pct, crossTitle(r.cross))}
      ${pctCell(r.hist?.enough ? r.hist.pct : null, histTitle(r.hist))}
      <td><button class="rowBtn ${r.watched ? 'on' : ''}" data-watch="${esc(r.key)}" title="${r.watched ? '已在关注列表' : '加入关注'}">${r.watched ? '★' : '☆'}</button></td>
    </tr>`;
  }).join('');
}

$('#boardBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-watch]');
  if (!btn) return;
  btn.disabled = true;
  try {
    const r = await api('/api/watch', { method: 'POST', body: { boardKey: btn.dataset.watch } });
    btn.classList.add('on');
    btn.textContent = '★';
    toast(r.created ? `已关注：${r.item.name.slice(0, 40)}` : '这台已经在关注列表里了', 'ok');
    loadCounts();
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = false;
  }
});

/* 榜单筛选 */
$('#fBoardQ').addEventListener('input', debounce((e) => { state.boardFilters.q = e.target.value; loadBoard(); }, 250));
$('#fBoardMax').addEventListener('input', debounce((e) => { state.boardFilters.maxPrice = e.target.value; loadBoard(); }, 350));
$('#fBoardSort').addEventListener('change', (e) => { state.boardFilters.sort = e.target.value; loadBoard(); });
$('#fBoardDrops').addEventListener('change', (e) => { state.boardFilters.onlyDrops = e.target.checked; loadBoard(); });
$('#fBoardStock').addEventListener('change', (e) => { state.boardFilters.inStock = e.target.checked; loadBoard(); });
$('#fBoardTrue').addEventListener('change', (e) => { state.boardFilters.trueDeal = e.target.checked; loadBoard(); });
bindSeg('#fBoardForm', (v) => { state.boardFilters.form = v; loadBoard(); });
bindSeg('#fBoardCond', (v) => { state.boardFilters.condition = v; loadBoard(); });
bindSeg('#fBoardShop', (v) => { state.boardFilters.retailer = v; loadBoard(); });

function bindSeg(sel, cb) {
  const box = $(sel);
  if (!box) return;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('button', box).forEach((x) => x.classList.toggle('on', x === b));
    cb(b.dataset.v);
  });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------------- 硬件 ---------------- */
/**
 * 硬件榜。和电脑榜共用 /api/board（只是带上 kind=hardware），
 * 分位、评分、关注那套逻辑完全复用 —— 差别只在展示哪几列：
 * 整机看 cpu/gpu/ram/disk，配件看芯片/显存。
 */
async function loadHardware() {
  const f = state.hwFilters;
  const qs = new URLSearchParams({
    kind: 'hardware',
    q: f.q, form: f.form, retailer: f.retailer, sort: f.sort,
    inStock: f.inStock ? '1' : '0',
    limit: '400',
  });
  if (f.maxPrice) qs.set('maxPrice', f.maxPrice);

  try {
    const data = await api(`/api/board?${qs}`);
    state.hwStats = data.stats || {};
    $('#cntHw').textContent = data.total;
    const st = data.stats || {};
    $('#hwCount').textContent =
      `${data.rows.length} / ${data.total} 件` +
      (data.total ? ` · 同档可比 ${st.withCross ?? 0} · 有历史 ${st.withHist ?? 0} · 真好价 ${st.trueDeals ?? 0}` : '') +
      // 默认不再隐藏缺货，所以要说清有多少是买不到的
      (st.soldOut ? ` · 已售罄 ${st.soldOut}` : '');

    const hint = $('#hwHint');
    if (data.total && !st.withHist) {
      hint.hidden = false;
      hint.innerHTML =
        '「历史」列还是空的：需要至少 <b>3 天</b>跟踪且价格<b>确实变动过</b>。' +
        '先看「同档」—— 同一颗芯片、同显存的卡互相比价，那一列现在就能用。';
    } else {
      hint.hidden = true;
    }
    // 首次进页面也要对齐表头（默认「全部」用中性说法）
    applyHwHeadings(f.form);
    applyShopColumn(st.retailers, $('#hwTable'), '#fHwShop', state.hwFilters);
    renderHardware(data.rows);
  } catch (e) {
    toast(e.message, 'err');
  }
}

function emptyHardwareMessage() {
  const f = state.hwFilters;
  const filtered = f.q || f.maxPrice || f.form !== 'all' || f.retailer !== 'all';
  if (filtered) {
    return `<b>当前筛选没有命中</b>硬件榜共 ${$('#cntHw').textContent} 件，放宽条件再试试`;
  }
  return (
    `<b>硬件榜还是空的</b>` +
    `默认带了一条「显卡」自动搜索，但要等它跑过一轮才会有数据。<br>` +
    `点右上角 <code>立即查询</code>，或去「自动搜索」确认那条是启用状态`
  );
}

/**
 * 硬件表的两个规格列，按品类填不同东西 —— 四类硬件的"关键规格"根本不是一回事：
 *   显卡  芯片 / 显存        CPU   核心数 / 插槽
 *   内存  容量类型 / —       硬盘  容量 / 接口
 * 表头也跟着「类型」筛选变（见 hwHeadings）。
 */
function hwSpecCells(s) {
  switch (s.form) {
    case 'gpu': return [dash(s.gpu), dash(s.vram)];
    case 'cpu': return [dash(s.cores ? `${s.cores} 核` : null), dash(s.socket)];
    case 'ram': return [dash(s.ram), dash(null)];
    case 'ssd': return [dash(s.disk), dash(s.bus)];
    default: return [dash(null), dash(null)];
  }
}

/* 「类型」筛选选中具体品类时，表头用该品类的说法；选「全部」时用中性说法。 */
const HW_HEADINGS = {
  all: ['规格', '规格 2'],
  gpu: ['芯片', '显存'],
  cpu: ['核心', '插槽'],
  ram: ['容量 / 类型', ''],
  ssd: ['容量', '接口'],
};

/**
 * 「商家」列和零售商筛选按钮，都按池子里实际有几家来定：
 * 只有一家时把列收起（别白占宽度）、按钮也不显示 —— 和重量列同一个思路。
 * 计数来自 stats.retailers，那是**筛选之前**统计的，所以按了筛选按钮
 * 其他家的计数不会归零、按钮不会自己消失。
 */
function applyShopColumn(counts, table, segSel, filters = state.hwFilters) {
  const shops = Object.keys(counts || {});
  const multi = shops.length > 1;
  table.classList.toggle('noShop', !multi);

  const seg = document.querySelector(segSel);
  if (!seg) return multi;
  if (!multi) { seg.hidden = true; return false; }
  seg.hidden = false;

  const want = ['all', ...shops.sort()];
  const have = [...seg.querySelectorAll('button')].map((b) => b.dataset.v);
  // 只有集合变了才重建，否则会把用户当前选中的按钮状态冲掉
  if (want.join() !== have.join()) {
    const cur = filters.retailer;
    seg.innerHTML = want
      .map((v) => {
        const label = v === 'all' ? '全部' : `${shopLabel(v)} ${counts[v]}`;
        return `<button data-v="${esc(v)}" class="${v === cur ? 'on' : ''}">${esc(label)}</button>`;
      })
      .join('');
  }
  return true;
}

function applyHwHeadings(form) {
  const [a, b] = HW_HEADINGS[form] || HW_HEADINGS.all;
  const th = document.querySelectorAll('#hwTable thead th');
  if (th[2]) th[2].textContent = a;
  if (th[3]) th[3].textContent = b;
}

function renderHardware(rows) {
  const body = $('#hwBody');
  const empty = $('#hwEmpty');
  if (!rows.length) {
    body.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = emptyHardwareMessage();
    return;
  }
  empty.hidden = true;

  const fresh = Date.now() - 86400000;
  body.innerHTML = rows.map((r) => {
    const s = r.specs || {};
    const dropped = r.lastDropAt && r.lastDropAt > fresh;
    const isLow = isNewLow(r);
    const title = [
      r.name,
      r.prevPrice != null && r.prevPrice !== r.price ? `上次 $${money(r.prevPrice)}` : '',
      r.minPrice != null ? `跟踪最低 $${money(r.minPrice)}` : '',
      `首次发现 ${relTime(r.firstSeenAt)}`,
      crossTitle(r.cross),
      histTitle(r.hist),
    ].filter(Boolean).join('  ·  ');

    // 品牌单独显示：同一颗芯片的差价基本就是品牌/散热方案的差价。
    // 通用内存条这类没有型号名（shortName 为 null），退回只显示品牌 —— 它们的
    // 身份就是规格本身，规格在右边两列里。
    const label = [s.brand, s.shortName].filter(Boolean).join(' ') || r.name;
    const [c1, c2] = hwSpecCells(s);

    return `<tr class="${[dropped ? 'hit' : '', r.deal?.trueDeal ? 'trueDeal' : '', r.inStock === false ? 'oos' : ''].filter(Boolean).join(' ')}" title="${esc(title)}">
      <td class="mono">${esc(r.sku)}</td>
      <td class="w-shop shop">${esc(shopLabel(r.retailer))}</td>
      <td class="name"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(label)}</a>${condBadge(r.condition)}${r.thirdParty ? '<span class="badge third" title="Best Buy Marketplace 第三方卖家">三方</span>' : ''}${isLow ? '<span class="badge low">新低</span>' : ''}${r.inStock === false ? '<span class="badge oos">缺货</span>' : ''}</td>
      <td>${c1}</td>
      <td>${c2}</td>
      ${priceCell(r.regularPrice, r.price)}
      ${offCell(r.percentOff)}
      ${pctCell(r.cross?.pct, crossTitle(r.cross))}
      ${pctCell(r.hist?.enough ? r.hist.pct : null, histTitle(r.hist))}
      <td><button class="rowBtn ${r.watched ? 'on' : ''}" data-watch="${esc(r.key)}" title="${r.watched ? '已在关注列表' : '加入关注'}">${r.watched ? '★' : '☆'}</button></td>
    </tr>`;
  }).join('');
}

// 关注按钮和电脑榜同一套处理
$('#hwBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-watch]');
  if (!btn) return;
  btn.disabled = true;
  try {
    const r = await api('/api/watch', { method: 'POST', body: { boardKey: btn.dataset.watch } });
    btn.classList.add('on');
    btn.textContent = '★';
    toast(r.created ? `已关注：${r.item.name.slice(0, 40)}` : '这件已经在关注列表里了', 'ok');
    loadCounts();
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = false;
  }
});

$('#fHwQ').addEventListener('input', debounce((e) => { state.hwFilters.q = e.target.value; loadHardware(); }, 250));
$('#fHwMax').addEventListener('input', debounce((e) => { state.hwFilters.maxPrice = e.target.value; loadHardware(); }, 350));
$('#fHwSort').addEventListener('change', (e) => { state.hwFilters.sort = e.target.value; loadHardware(); });
$('#fHwStock').addEventListener('change', (e) => { state.hwFilters.inStock = e.target.checked; loadHardware(); });
bindSeg('#fHwForm', (v) => { state.hwFilters.form = v; applyHwHeadings(v); loadHardware(); });
bindSeg('#fHwShop', (v) => { state.hwFilters.retailer = v; loadHardware(); });

/* ---------------- 历史记录 ---------------- */
async function loadEvents() {
  const f = state.evFilters;
  const qs = new URLSearchParams({ q: f.q, type: f.type, sort: f.sort, limit: '400' });
  if (f.since) qs.set('since', String(Date.now() - Number(f.since) * 86400000));

  try {
    const data = await api(`/api/events?${qs}`);
    state.evStats = { grandTotal: data.grandTotal, byType: data.byType || {}, board: data.board || {} };
    $('#cntEvents').textContent = data.total;
    $('#evCount').textContent = `${data.rows.length} / ${data.total} 条`;
    renderEvents(data.rows);
  } catch (e) {
    toast(e.message, 'err');
  }
}

const TAG_LABEL = {
  drop: '降价', target: '到价', found: '新发现', rise: '涨价',
  restock: '补货', baseline: '开始跟踪', error: '错误',
};

/**
 * 空历史记录的文案。
 * 「一条都没有」和「有记录但当前筛选没命中」是两回事 ——
 * 之前统一说"还没有记录"，结果榜上明明跟着 97 台，点「降价」却像是坏了。
 */
function emptyEventsMessage() {
  const st = state.evStats || {};
  const b = st.board || {};
  const f = state.evFilters;
  const isDropFilter = f.type === 'drop,target';

  if (!st.grandTotal) {
    return b.tracked
      ? `<b>还没有记录</b>已经收录了 ${b.tracked} 台机器，但还没产生过事件<br>等下一轮定时查询`
      : `<b>还没有记录</b>点右上角「立即查询」跑第一轮，查到的机器和降价都会记在这里`;
  }

  if (f.q || f.since) {
    return `<b>当前筛选没有命中</b>共 ${st.grandTotal} 条记录，换个关键词或时间范围试试`;
  }

  if (isDropFilter) {
    const parts = [`<b>还没有降过价的机器</b>`];
    parts.push(
      `已经在跟踪 <code>${b.tracked || 0}</code> 台，其中 <code>${b.rechecked || 0}</code> 台复查过至少一次，价格都还没动过。`
    );
    parts.push(
      `降价记录要等同一台机器<b style="color:var(--fg-dim)">在两轮查询之间真的降了价</b>才会出现 —— Best Buy 的促销一般按周更新，别指望每小时都有。`
    );
    if (b.oldestSeenAt) {
      const days = (Date.now() - b.oldestSeenAt) / 86400000;
      parts.push(
        days < 1
          ? `你才跟踪了 ${Math.max(1, Math.round((Date.now() - b.oldestSeenAt) / 3600000))} 小时，再等等。`
          : `已跟踪 ${Math.round(days)} 天。`
      );
    }
    parts.push(`想看已经收录了哪些机器 → 上面切到「新发现」或「全部」`);
    return parts.join('<br>');
  }

  const label = { found: '新发现' }[f.type] || '这一类';
  return `<b>没有${label}的记录</b>共 ${st.grandTotal} 条记录，切到「全部」看看`;
}

function renderEvents(rows) {
  const body = $('#evBody');
  const empty = $('#evEmpty');
  if (!rows.length) {
    body.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = emptyEventsMessage();
    return;
  }
  empty.hidden = true;

  body.innerHTML = rows.map((e) => {
    const s = e.specs || {};
    const showPrev = e.prevPrice != null && e.prevPrice !== e.price;
    return `<tr class="${e.type === 'drop' || e.type === 'target' ? 'hit' : ''}" title="${esc(e.name || '')}${e.note ? ' · ' + esc(e.note) : ''}">
      ${timeCell(e)}
      <td class="left"><span class="tag ${esc(e.type)}">${TAG_LABEL[e.type] || esc(e.type)}</span></td>
      <td class="name">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(s.shortName || e.name || '—')}</a>` : esc(e.name || '—')}${condBadge(e.condition)}${e.isAllTimeLow ? '<span class="badge low">新低</span>' : ''}</td>
      <td class="left">${dash(s.cpu)}</td>
      <td>${dash(s.gpu)}</td>
      <td>${dash(s.ram)}</td>
      <td>${dash(s.disk)}</td>
      ${priceCell(showPrev ? e.prevPrice : e.regularPrice, e.price, e.type === 'rise' ? 'rise' : '')}
      ${e.delta ? `<td class="off ${e.type === 'rise' ? 'up' : 'on'}">${e.type === 'rise' ? '+' : '-'}$${money(e.delta)}</td>` : '<td class="off zero">—</td>'}
      <td class="left" style="color:var(--fg-mute);font-size:11px">${esc(e.searchName || '关注列表')}</td>
    </tr>`;
  }).join('');
}

$('#fEvQ').addEventListener('input', debounce((e) => { state.evFilters.q = e.target.value; loadEvents(); }, 250));
$('#fEvSince').addEventListener('change', (e) => { state.evFilters.since = e.target.value; loadEvents(); });
$('#fEvSort').addEventListener('change', (e) => { state.evFilters.sort = e.target.value; loadEvents(); });
bindSeg('#fEvType', (v) => { state.evFilters.type = v; loadEvents(); });

$('#btnClearEvents').addEventListener('click', async () => {
  if (!confirm('清空全部历史记录？价格曲线和电脑榜不受影响。')) return;
  await api('/api/events/clear', { method: 'POST' });
  toast('历史记录已清空', 'ok');
  loadEvents();
});

/* ---------------- 关注列表 ---------------- */
async function loadWatch() {
  try {
    const { items } = await api('/api/watch');
    $('#cntWatch').textContent = items.length;
    renderWatch(items);
  } catch (e) {
    toast(e.message, 'err');
  }
}

function sparkline(points) {
  const vals = points.map((p) => p.price).filter((v) => v != null);
  if (vals.length < 2) return '<span style="color:var(--fg-mute)">·</span>';
  const w = 84, h = 20, pad = 2;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const step = (w - pad * 2) / (vals.length - 1);
  const pts = vals.map((v, i) => [pad + i * step, h - pad - ((v - min) / span) * (h - pad * 2)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${d} L${pts.at(-1)[0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`;
  const rising = vals.at(-1) > vals[0];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <path class="area" d="${area}" style="fill:${rising ? 'rgba(244,115,122,.1)' : 'rgba(70,209,127,.12)'}"/>
    <path d="${d}" style="stroke:${rising ? 'var(--up)' : 'var(--down)'}"/>
  </svg>`;
}

async function renderWatch(items) {
  const body = $('#watchBody');
  const empty = $('#watchEmpty');
  if (!items.length) {
    body.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = '<b>关注列表是空的</b>在「电脑榜」里点 ☆ 关注，或者上面直接贴商品链接<br>关注的机器每轮都会单独查价，并保留完整价格曲线';
    return;
  }
  empty.hidden = true;

  body.innerHTML = items.map((w) => {
    const s = w.specs || {};
    const cur = w.current?.price ?? null;
    const first = w.first?.price ?? null;
    const diff = cur != null && first != null ? cur - first : null;
    const diffPct = diff != null && first ? (diff / first) * 100 : null;
    const isLow = w.low && cur != null && cur <= w.low.price && (w.drops || 0) > 0 && (w.checks || 0) >= 3;
    return `<tr title="${esc(w.name)}${w.lastError ? ' · ⚠ ' + esc(w.lastError) : ''}">
      <td class="mono">${esc(w.sku)}</td>
      <td class="name"><a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(s.shortName || w.name)}</a>${condBadge(w.condition)}${isLow ? '<span class="badge low">新低</span>' : ''}${w.lastError ? '<span class="badge oos" title="' + esc(w.lastError) + '">!</span>' : ''}</td>
      <td class="left">${dash(s.cpu)}</td>
      <td>${dash(s.gpu)}</td>
      <td>${dash(s.ram)}</td>
      ${priceCell(w.current?.regularPrice, cur)}
      <td class="off ${diff == null ? 'zero' : diff < 0 ? 'on' : diff > 0 ? 'up' : 'zero'}">${
        diff == null ? '—' : diff === 0 ? '持平' : `${diff < 0 ? '-' : '+'}${Math.abs(diffPct).toFixed(0)}%`
      }</td>
      <td>${w.low ? money(w.low.price) : '—'}</td>
      <td><input class="in" style="width:78px;padding:2px 6px;font-family:var(--mono);text-align:right" type="number" value="${w.targetPrice ?? ''}" placeholder="—" data-target="${esc(w.id)}"></td>
      <td data-spark="${esc(w.id)}"><span style="color:var(--fg-mute)">·</span></td>
      <td><button class="rowBtn del" data-del="${esc(w.id)}" title="取消关注">✕</button></td>
    </tr>`;
  }).join('');

  // 走势图按需加载
  for (const w of items) {
    api(`/api/watch/${w.id}/history`)
      .then(({ points }) => {
        const cell = $(`[data-spark="${w.id}"]`);
        if (cell) cell.innerHTML = sparkline(points);
      })
      .catch(() => {});
  }
}

$('#watchBody').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (!del) return;
  if (!confirm('取消关注并删除这台机器的价格历史？')) return;
  await api(`/api/watch/${del.dataset.del}`, { method: 'DELETE' });
  toast('已取消关注', 'ok');
  loadWatch();
  loadCounts();
});

$('#watchBody').addEventListener('change', async (e) => {
  const inp = e.target.closest('[data-target]');
  if (!inp) return;
  const v = inp.value === '' ? null : Number(inp.value);
  try {
    await api(`/api/watch/${inp.dataset.target}`, { method: 'PATCH', body: { targetPrice: v } });
    toast(v == null ? '已清除目标价' : `目标价设为 $${v}，跌破时会单独提醒`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});

async function addWatch() {
  const input = $('#watchInput').value.trim();
  if (!input) return;
  const target = $('#watchTarget').value;
  $('#btnAddWatch').disabled = true;
  try {
    const r = await api('/api/watch', {
      method: 'POST',
      body: { input, targetPrice: target ? Number(target) : null },
    });
    toast(r.created ? `已关注：${r.item.name.slice(0, 40)}` : '这台已经在关注列表里了', 'ok');
    $('#watchInput').value = '';
    $('#watchTarget').value = '';
    loadWatch();
    loadCounts();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    $('#btnAddWatch').disabled = false;
  }
}
$('#btnAddWatch').addEventListener('click', addWatch);
$('#watchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addWatch(); });

/* ---------------- 自动搜索 ---------------- */
function renderSearches() {
  $('#cntSearch').textContent = state.searches.filter((s) => s.enabled !== false).length;
  const box = $('#searchList');
  if (!state.searches.length) {
    box.innerHTML = '<div class="empty"><b>还没有自动搜索</b>新建一条，定时查询就会自动帮你扫这个条件下的降价</div>';
    return;
  }

  box.innerHTML = state.searches.map((s) => {
    const cat = state.categories.find((c) => c.id === s.categoryId);
    const bits = [
      s.channel === 'openbox' ? 'Open Box' : '普通目录',
      cat ? cat.name.replace(/\s*\(.*\)/, '') : s.categoryId || '全站',
      s.condition !== 'any' ? { new: '全新', refurbished: '官翻', preowned: '二手', openbox: '拆封' }[s.condition] : null,
      s.keywords ? `“${s.keywords}”` : null,
      s.maxPrice ? `≤$${s.maxPrice}` : null,
      s.minPrice ? `≥$${s.minPrice}` : null,
      s.minPercentOff ? `折扣≥${s.minPercentOff}%` : null,
      s.onSaleOnly ? '仅在售折扣' : null,
    ].filter(Boolean);

    return `<div class="scard ${s.enabled === false ? 'off' : ''}">
      <header>
        <label class="switch"><input type="checkbox" data-toggle="${esc(s.id)}" ${s.enabled !== false ? 'checked' : ''}><span></span></label>
        <h4>${esc(s.name)}</h4>
      </header>
      <div class="meta">${bits.map((b) => esc(b)).join(' · ')}</div>
      <div class="meta">
        <b>上次</b> ${s.lastRunAt ? relTime(s.lastRunAt) : '还没跑过'}
        ${s.lastCount != null ? ` · 命中 <b>${s.lastCount}</b> 台` : ''}
        ${s.lastMeta?.filteredOut ? ` · 滤掉 ${s.lastMeta.filteredOut} 个非电脑` : ''}
      </div>
      ${s.lastError ? `<div class="err">⚠ ${esc(s.lastError)}</div>` : ''}
      <div class="acts">
        <button class="btn sm" data-run="${esc(s.id)}">立即运行</button>
        <button class="btn sm" data-edit="${esc(s.id)}">编辑</button>
        <span style="flex:1"></span>
        <button class="btn sm danger" data-rm="${esc(s.id)}">删除</button>
      </div>
    </div>`;
  }).join('');
}

$('#searchList').addEventListener('change', async (e) => {
  const t = e.target.closest('[data-toggle]');
  if (!t) return;
  await api(`/api/searches/${t.dataset.toggle}`, { method: 'PATCH', body: { enabled: t.checked } });
  const s = state.searches.find((x) => x.id === t.dataset.toggle);
  if (s) s.enabled = t.checked;
  renderSearches();
});

$('#searchList').addEventListener('click', async (e) => {
  const run = e.target.closest('[data-run]');
  const edit = e.target.closest('[data-edit]');
  const rm = e.target.closest('[data-rm]');

  if (run) {
    run.disabled = true;
    run.textContent = '查询中…';
    try {
      const r = await api(`/api/searches/${run.dataset.run}/run`, { method: 'POST' });
      const extra = r.meta?.droppedFilters?.length ? `（${r.meta.droppedFilters.join('/')} 改为本地过滤）` : '';
      toast(`命中 ${r.count} 台，新发现 ${r.newCount}，降价 ${r.dropCount}${extra}`, 'ok');
      await loadSearches();
      loadCounts();
    } catch (err) {
      toast(err.message, 'err');
      await loadSearches();
    }
  }

  if (edit) openSearchModal(state.searches.find((s) => s.id === edit.dataset.edit));

  if (rm) {
    if (!confirm('删除这条自动搜索？')) return;
    await api(`/api/searches/${rm.dataset.rm}`, { method: 'DELETE' });
    toast('已删除', 'ok');
    loadSearches();
  }
});

async function loadSearches() {
  const { items } = await api('/api/searches');
  state.searches = items;
  renderSearches();
}

/* 搜索编辑弹层 */
$('#btnAddSearch').addEventListener('click', () => openSearchModal(null));

function openSearchModal(s) {
  state.editingSearch = s;
  const form = $('#searchForm');
  $('#searchModalTitle').textContent = s ? '编辑搜索' : '新建搜索';

  const sel = $('#searchCategory');
  sel.innerHTML =
    '<option value="">全站（不限分类）</option>' +
    state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  if (s?.categoryId && !state.categories.some((c) => c.id === s.categoryId)) {
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(s.categoryId)}">${esc(s.categoryId)}（自定义）</option>`);
  }

  form.name.value = s?.name ?? '';
  form.channel.value = s?.channel ?? 'api';
  form.condition.value = s?.condition ?? 'any';
  form.categoryId.value = s?.categoryId ?? 'abcat0502000';
  form.keywords.value = s?.keywords ?? '';
  form.minPrice.value = s?.minPrice ?? '';
  form.maxPrice.value = s?.maxPrice ?? '';
  form.minPercentOff.value = s?.minPercentOff ?? '';
  form.sort.value = s?.sort ?? 'percentSavings.desc';
  form.limit.value = s?.limit ?? 60;
  form.onlySale.checked = !!s?.onSaleOnly;

  $('#searchModal').showModal();
}

$('#searchForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  const f = e.target;
  const payload = {
    name: f.name.value.trim(),
    channel: f.channel.value,
    condition: f.condition.value,
    categoryId: f.categoryId.value,
    keywords: f.keywords.value.trim(),
    minPrice: f.minPrice.value ? Number(f.minPrice.value) : null,
    maxPrice: f.maxPrice.value ? Number(f.maxPrice.value) : null,
    minPercentOff: f.minPercentOff.value ? Number(f.minPercentOff.value) : 0,
    onSaleOnly: f.onlySale.checked,
    sort: f.sort.value,
    limit: Number(f.limit.value) || 60,
  };
  try {
    if (state.editingSearch) {
      await api(`/api/searches/${state.editingSearch.id}`, { method: 'PATCH', body: payload });
    } else {
      await api('/api/searches', { method: 'POST', body: payload });
    }
    toast('已保存', 'ok');
    loadSearches();
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* ---------------- 设置 ---------------- */
function fillSettings() {
  const s = state.settings;
  if (!s) return;
  $('#apiKeyHint').textContent = s.hasApiKey ? `已保存：${s.apiKeyHint}` : '没配也能用 —— 默认的浏览器通道不需要它';
  $('#setProvider').value = s.provider;
  $('#setOnlyComputers').checked = s.onlyComputers;
  $('#setHideThird').checked = s.hideThirdParty;
  $('#setHeadless').checked = s.browserHeadless !== false;
  $('#setMaxPages').value = s.maxPagesPerSearch;
  $('#providerHint').textContent = state.browser
    ? `浏览器通道用的是本机的 ${state.browser.name}，只读公开的商品页；遇到验证码会立刻停手并报错，不做绕过。`
    : '没找到 Edge 或 Chrome —— 浏览器通道用不了，请装一个。';
  $('#setInterval').value = s.intervalMinutes;
  $('#setAutoStart').checked = s.autoStart;
  $('#setRunOnLaunch').checked = s.runOnLaunch;
  $('#setQuiet').checked = s.quietHours.enabled;
  $('#setQuietStart').value = s.quietHours.start;
  $('#setQuietEnd').value = s.quietHours.end;
  $('#setMinPct').value = s.dropMinPercent;
  $('#setMinAmt').value = s.dropMinAmount;
  $('#setToast').checked = s.notify.toast;
  $('#setSound').checked = s.notify.sound;
  $('#setOnlyWatch').checked = s.notify.onlyWatchlist;
  $('#dataDir').textContent = s.dataDir || state.dataDir || '—';

  const lc = state.status?.lastCycle;
  $('#lastCycle').textContent = lc
    ? `${relTime(lc.startedAt)} · 关注 ${lc.watchChecked} 台 / 搜索 ${lc.searchesRun} 条 · 降价 ${lc.drops} · 新发现 ${lc.discovered}${lc.errors?.length ? ` · ${lc.errors.length} 个错误` : ''}`
    : '还没跑过';
}

$('#btnSaveSettings').addEventListener('click', async () => {
  const payload = {
    provider: $('#setProvider').value,
    onlyComputers: $('#setOnlyComputers').checked,
    hideThirdParty: $('#setHideThird').checked,
    browserHeadless: $('#setHeadless').checked,
    maxPagesPerSearch: Number($('#setMaxPages').value) || 3,
    intervalMinutes: Number($('#setInterval').value) || 30,
    autoStart: $('#setAutoStart').checked,
    runOnLaunch: $('#setRunOnLaunch').checked,
    quietHours: {
      enabled: $('#setQuiet').checked,
      start: $('#setQuietStart').value || '23:30',
      end: $('#setQuietEnd').value || '08:00',
    },
    dropMinPercent: Number($('#setMinPct').value) || 0,
    dropMinAmount: Number($('#setMinAmt').value) || 0,
    notify: {
      toast: $('#setToast').checked,
      sound: $('#setSound').checked,
      onlyWatchlist: $('#setOnlyWatch').checked,
    },
  };
  const key = $('#setApiKey').value.trim();
  if (key) payload.apiKey = key;

  try {
    const r = await api('/api/settings', { method: 'PUT', body: payload });
    state.settings = r.settings;
    state.status = r.status;
    $('#setApiKey').value = '';
    fillSettings();
    renderStatus();
    const hint = $('#saveHint');
    hint.textContent = '✓ 已保存';
    setTimeout(() => { hint.textContent = ''; }, 2500);
  } catch (e) {
    toast(e.message, 'err');
  }
});

$$('[data-diag]').forEach((b) =>
  b.addEventListener('click', async () => {
    const out = $('#diagOut');
    out.hidden = false;
    out.textContent = '测试中…';
    try {
      const { results } = await api('/api/diagnose', { method: 'POST', body: { target: b.dataset.diag } });
      out.textContent = Object.entries(results)
        .map(([k, v]) => `${v.ok ? '✓' : '✗'} ${k}${v.ms != null ? ` (${v.ms}ms)` : ''} — ${v.detail}`)
        .join('\n');
    } catch (e) {
      out.textContent = '✗ ' + e.message;
    }
  })
);

$('#btnCatSearch').addEventListener('click', searchCategories);
$('#catQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchCategories(); } });

async function searchCategories() {
  const q = $('#catQ').value.trim();
  const box = $('#catList');
  box.innerHTML = '<div class="catRow"><span>查询中…</span></div>';
  try {
    const { categories } = await api(`/api/categories?q=${encodeURIComponent(q)}`);
    if (!categories.length) { box.innerHTML = '<div class="catRow"><span>没查到</span></div>'; return; }
    box.innerHTML = categories.map((c) =>
      `<div class="catRow" data-cat="${esc(c.id)}" title="点击复制 ID"><code>${esc(c.id)}</code><span>${esc(c.name)}${c.path ? ' · ' + esc(c.path) : ''}</span></div>`
    ).join('');
  } catch (e) {
    box.innerHTML = `<div class="catRow"><span style="color:var(--up)">${esc(e.message)}</span></div>`;
  }
}

$('#catList').addEventListener('click', (e) => {
  const row = e.target.closest('[data-cat]');
  if (!row) return;
  navigator.clipboard?.writeText(row.dataset.cat);
  toast(`已复制分类 ID：${row.dataset.cat}`, 'ok');
});

$('#btnClearBoard').addEventListener('click', async () => {
  if (!confirm('清空电脑榜？下轮查询会重新建立基线（届时所有机器都会算成"新发现"）。历史记录不受影响。')) return;
  await api('/api/board/clear', { method: 'POST' });
  toast('电脑榜已清空', 'ok');
  loadBoard();
});

async function loadLogs() {
  try {
    const { lines } = await api('/api/logs?limit=120');
    const box = $('#logBox');
    box.innerHTML = lines.map(fmtLog).join('\n');
    box.scrollTop = box.scrollHeight;
  } catch { /* ignore */ }
}

function fmtLog(l) {
  const t = new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false });
  return `<span class="t">${t}</span> <span class="lv-${esc(l.level)}">${esc(l.msg)}</span>${l.extra ? ' ' + esc(l.extra) : ''}`;
}


/* ---------------- 特别关注 ---------------- */
async function loadAlerts() {
  try {
    const { items } = await api('/api/alerts');
    renderAlerts(items);
  } catch (e) { toast(e.message, 'err'); }
}

function renderAlerts(items) {
  const box = $('#alertList');
  if (!items.length) {
    box.innerHTML = '<div class="catRow"><span>还没有规则。设一条，比如关键词 <code>zephyrus g14</code>、降幅 15%</span></div>';
    return;
  }
  box.innerHTML = items.map((a) => {
    const bits = [
      a.retailer !== 'any' ? shopLabel(a.retailer) : null,
      a.minPercent ? `≥${a.minPercent}%` : null,
      a.minAmount ? `≥${a.minAmount}` : null,
      a.maxPrice != null ? `≤${a.maxPrice}` : null,
      a.ignoreQuietHours ? '免打扰也提醒' : null,
    ].filter(Boolean);
    return `<div class="catRow" style="justify-content:space-between;${a.enabled === false ? 'opacity:.45' : ''}">
      <span style="flex:1">
        <code>${esc(a.keyword)}</code>
        <span style="color:var(--fg-mute)"> ${esc(bits.join(' · '))}</span>
      </span>
      <label class="chk" style="margin-right:8px"><input type="checkbox" data-al-on="${esc(a.id)}" ${a.enabled !== false ? 'checked' : ''}> 启用</label>
      <button class="btn sm danger" data-al-rm="${esc(a.id)}">删除</button>
    </div>`;
  }).join('');
}

$('#btnAddAlert').addEventListener('click', async () => {
  const keyword = $('#alKeyword').value.trim();
  if (!keyword) { toast('先填关键词（品牌或型号）', 'err'); return; }
  try {
    const { items } = await api('/api/alerts', { method: 'POST', body: {
      keyword,
      retailer: $('#alRetailer').value,
      minPercent: $('#alPct').value,
      minAmount: $('#alAmt').value,
      maxPrice: $('#alMax').value,
      ignoreQuietHours: $('#alQuiet').checked,
    }});
    $('#alKeyword').value = '';
    renderAlerts(items);
    toast(`已添加特别关注：${keyword}`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

$('#alKeyword').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnAddAlert').click(); });

$('#alertList').addEventListener('click', async (e) => {
  const rm = e.target.closest('[data-al-rm]');
  if (!rm) return;
  if (!confirm('删除这条特别关注？')) return;
  const { items } = await api(`/api/alerts/${rm.dataset.alRm}`, { method: 'DELETE' });
  renderAlerts(items);
  toast('已删除', 'ok');
});

$('#alertList').addEventListener('change', async (e) => {
  const t = e.target.closest('[data-al-on]');
  if (!t) return;
  const { items } = await api(`/api/alerts/${t.dataset.alOn}`, { method: 'PATCH', body: { enabled: t.checked } });
  renderAlerts(items);
});

/* ---------------- 状态栏 ---------------- */
function renderStatus() {
  const s = state.status;
  if (!s) return;
  const dot = $('#statusDot');
  const text = $('#statusText');

  dot.className = 'dot ' + (s.cycleInProgress ? 'busy' : s.running ? 'on' : 'off');
  text.textContent = s.cycleInProgress
    ? '正在查询…'
    : s.running
      ? `每 ${s.intervalMinutes} 分钟自动查询`
      : '已停止';

  $('#btnToggle').textContent = s.running ? '停止' : '启动';
  $('#btnRun').disabled = s.cycleInProgress;
}

function tickCountdown() {
  const s = state.status;
  const el = $('#countdown');
  if (!s?.running || !s.nextRunAt) { el.textContent = s?.cycleInProgress ? '进行中' : '—'; return; }
  const left = Math.max(0, s.nextRunAt - Date.now());
  const m = Math.floor(left / 60000);
  const sec = Math.floor((left % 60000) / 1000);
  el.textContent = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
setInterval(tickCountdown, 1000);

$('#btnRun').addEventListener('click', async () => {
  try {
    const r = await api('/api/tracker/run', { method: 'POST' });
    state.status = r.status;
    renderStatus();
    toast('已开始查询，结果会自动刷新');
  } catch (e) {
    toast(e.message, 'err');
  }
});

$('#btnToggle').addEventListener('click', async () => {
  const running = state.status?.running;
  const r = await api(`/api/tracker/${running ? 'stop' : 'start'}`, { method: 'POST' });
  state.status = r.status;
  renderStatus();
  toast(running ? '已停止定时查询' : '定时查询已启动', 'ok');
});

/* ---------------- SSE ---------------- */
function connectStream() {
  const es = new EventSource('/api/stream');
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'status' || msg.type === 'hello') {
      state.status = msg.payload;
      renderStatus();
    } else if (msg.type === 'cycle') {
      state.status = { ...state.status, lastCycle: msg.payload, cycleInProgress: false };
      renderStatus();
      const c = msg.payload;
      if (c.drops || c.discovered) {
        toast(`查询完成：降价 ${c.drops} 条，新发现 ${c.discovered} 台`, 'ok');
      }
      if (c.errors?.length) toast(c.errors[0], 'err');
      loadCounts();
      refreshTab();
    } else if (msg.type === 'board') {
      if (state.tab === 'board') loadBoard();
    } else if (msg.type === 'log' && state.tab === 'settings') {
      const box = $('#logBox');
      if (box) {
        box.insertAdjacentHTML('beforeend', '\n' + fmtLog(msg.payload));
        box.scrollTop = box.scrollHeight;
      }
    }
  };
  es.onerror = () => { /* EventSource 会自己重连 */ };
}

/* ---------------- 计数 ---------------- */
async function loadCounts() {
  try {
    // 硬件榜的计数也要在这里拿。以前只在 loadHardware() 里设，
    // 结果不点进硬件页就一直显示「硬件 0」（实测榜上 267 件）。
    const [b, h, e, w] = await Promise.all([
      api('/api/board?limit=1'),
      api('/api/board?limit=1&kind=hardware'),
      api('/api/events?limit=1&type=all'),
      api('/api/watch'),
    ]);
    $('#cntBoard').textContent = b.total;
    $('#cntHw').textContent = h.total;
    $('#cntEvents').textContent = e.total;
    $('#cntWatch').textContent = w.items.length;
  } catch { /* ignore */ }
}

/* ---------------- 启动 ---------------- */
(async function init() {
  try {
    const boot = await api('/api/bootstrap');
    state.settings = boot.settings;
    state.status = boot.status;
    state.categories = boot.categories;
    state.searches = boot.searches;
    state.dataDir = boot.dataDir;
    state.browser = boot.browser;
    state.settings.dataDir = boot.dataDir;

    renderStatus();
    renderSearches();
    loadCounts();
    loadBoard();
    connectStream();

    // 只在通道真的用不了的时候才报警。默认的浏览器通道压根不需要 API Key，
    // 以前这里无条件按 hasApiKey 判断，导致明明能查却一直弹"需要 API Key"。
    const s = boot.settings;
    const onWeb = s.provider === 'web' || (s.provider === 'auto' && !s.hasApiKey);
    const problem =
      s.provider === 'api' && !s.hasApiKey
        ? '通道选的是「官方 API」但没填 Key —— 去「设置」换成「浏览器读网页」，或者填入 Key'
        : onWeb && !boot.browser
          ? '没找到 Edge 或 Chrome —— 浏览器通道需要本机有其中之一，装好后重启本软件'
          : null;

    if (problem) setTimeout(() => toast(problem, 'err'), 600);
  } catch (e) {
    document.body.insertAdjacentHTML(
      'afterbegin',
      `<div style="padding:30px;color:#f4737a;font-family:var(--mono)">启动失败：${esc(e.message)}</div>`
    );
  }
})();
