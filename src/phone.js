/**
 * 手机推送。电脑前不在的时候，降价也能第一时间知道。
 *
 * 两个通道，都是一个 HTTP 请求，零依赖：
 *   ntfy  — iOS/Android 都有官方 App，免注册、免费、开源，可以自建服务器。
 *           手机 App 里订阅一个「主题」，这边往同名主题发就收到。
 *           **主题名就是密码**：谁知道它谁就能收到你的推送，所以要用随机的长串。
 *   bark  — 只有 iOS，国内用户常用。App 里直接给一个设备 key。
 *
 * 默认只推「特别关注」的命中：一轮普通降价动辄 20 多条，全推到手机上会让人想卸载。
 * 任何失败都只记日志，绝不影响查询主流程和桌面通知。
 */
import { log } from './util.js';

const TIMEOUT_MS = 8000;

async function post(url, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text: text.slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, text: e.name === 'AbortError' ? `超时（${TIMEOUT_MS}ms）` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

const trimSlash = (s) => String(s || '').trim().replace(/\/+$/, '');

/** 发一条。返回 { ok, detail } */
export async function pushPhone({ title, body, url, urgent = false }, phone = {}) {
  if (phone.provider === 'bark') {
    const key = String(phone.barkKey || '').trim();
    if (!key) return { ok: false, detail: '还没填 Bark 的设备 key' };
    // 用 JSON 发而不是拼进 URL 路径 —— 商品名里有中文、斜杠、引号，拼路径很容易坏
    const r = await post(`${trimSlash(phone.barkServer) || 'https://api.day.app'}/push`, {
      device_key: key,
      title,
      body,
      url: url || undefined,
      group: '降价雷达',
      // 特别关注用 timeSensitive：iOS 专注模式下也能弹出来
      level: urgent ? 'timeSensitive' : 'active',
    });
    return r.ok ? { ok: true, detail: '已推送到 Bark' } : { ok: false, detail: `Bark 返回 ${r.status}：${r.text}` };
  }

  // 默认 ntfy
  const topic = String(phone.ntfyTopic || '').trim();
  if (!topic) return { ok: false, detail: '还没填 ntfy 的主题名' };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) {
    return { ok: false, detail: 'ntfy 主题名只能用字母、数字、- 和 _，最长 64 位' };
  }
  // 用 ntfy 的 JSON 发布接口，而不是把标题塞进 HTTP 头 ——
  // HTTP 头只能放 ASCII，中文标题放进去会乱码或直接被拒。
  const r = await post(trimSlash(phone.ntfyServer) || 'https://ntfy.sh', {
    topic,
    title,
    message: body,
    click: url || undefined,
    // 5 = 最高（会响铃、锁屏也弹），3 = 默认
    priority: urgent ? 5 : 3,
    tags: [urgent ? 'rotating_light' : 'moneybag'],
  });
  return r.ok ? { ok: true, detail: '已推送到 ntfy' } : { ok: false, detail: `ntfy 返回 ${r.status}：${r.text}` };
}

/**
 * 把本轮的降价推到手机。
 * 传进来的 drops 已经过了免打扰过滤（和桌面通知同一份），这里只按手机自己的规则再筛。
 */
export async function pushDrops(drops, settings) {
  const phone = settings?.phone;
  if (!phone?.enabled || !drops?.length) return;

  // 特别关注永远推、排在最前；普通降价要打开 onlyAlerts=false 才推，并且限量
  const urgent = drops.filter((d) => d.alertHit);
  const normal = phone.onlyAlerts === false ? drops.filter((d) => !d.alertHit) : [];
  const cap = Math.max(1, phone.maxPerCycle || 3);
  const list = [...urgent, ...normal.slice(0, cap)];
  const skipped = normal.length - Math.min(normal.length, cap);

  let sent = 0;
  let failed = null;
  for (const d of list) {
    const hit = d.alertHit;
    const pct = d.pct ? ` (-${d.pct}%)` : '';
    const from = d.prevPrice != null ? `$${d.prevPrice} → ` : '';
    const r = await pushPhone(
      {
        title: hit ? hit.title || `⚡ 特别关注：${hit.keyword}` : '降价了',
        body: `${d.name}\n${from}$${d.price}${pct}${hit?.note ? '\n' + hit.note : ''}`,
        url: d.url,
        urgent: !!hit,
      },
      phone
    );
    if (r.ok) sent++;
    else failed = r.detail;
  }

  if (skipped > 0) {
    await pushPhone(
      { title: `还有 ${skipped} 条降价`, body: '打开降价雷达看完整历史记录', urgent: false },
      phone
    );
  }

  if (failed) log.warn('手机推送有失败', failed);
  else if (sent) log.info(`已推送 ${sent} 条到手机`);
}

/** 设置页「测手机」按钮 */
export async function pingPhone(settings) {
  const phone = settings?.phone || {};
  const r = await pushPhone(
    {
      title: '降价雷达 · 测试推送',
      body: '手机推送通道正常。特别关注的降价会这样出现在这里。',
      urgent: false,
    },
    phone
  );
  return { ok: r.ok, detail: r.detail };
}
