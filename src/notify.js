/**
 * Windows 桌面通知。
 *
 * 不引第三方依赖：直接用 WinRT 的 ToastNotificationManager，借用系统自带
 * 已注册的 PowerShell AppUserModelID。用 -EncodedCommand 传脚本，避免
 * 商品名里的引号/中文/&符号把命令行拼坏。
 * 任何失败都只记日志，绝不影响查询主流程。
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import { log } from './util.js';

const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildScript({ title, body, launchUrl, sound }) {
  const launchAttr = launchUrl
    ? ` activationType="protocol" launch="${xmlEscape(launchUrl)}"`
    : '';
  const audio = sound
    ? '<audio src="ms-winsoundevent:Notification.Default"/>'
    : '<audio silent="true"/>';

  const toastXml = `<toast${launchAttr}>
  <visual>
    <binding template="ToastGeneric">
      <text>${xmlEscape(title)}</text>
      <text>${xmlEscape(body)}</text>
    </binding>
  </visual>
  ${audio}
</toast>`;

  // PowerShell 里用 here-string 承载 XML，避免二次转义
  return `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml(@'
${toastXml}
'@)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_AUMID}').Show($toast)
`;
}

let toastSupported = os.platform() === 'win32';
let warnedOnce = false;

export function notify({ title, body, launchUrl, sound = false }) {
  if (!toastSupported) return Promise.resolve(false);

  const script = buildScript({ title, body, launchUrl, sound });
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
      );
    } catch (e) {
      if (!warnedOnce) {
        log.warn('桌面通知不可用，已自动关闭', e.message);
        warnedOnce = true;
      }
      toastSupported = false;
      return resolve(false);
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, 8000);

    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !warnedOnce) {
        log.warn('桌面通知发送失败（后续不再重复提示）', stderr.slice(0, 200));
        warnedOnce = true;
      }
      resolve(code === 0);
    });
  });
}

export async function notifyDrops(drops, settings) {
  if (!settings?.notify?.toast || !drops.length) return;
  const max = settings.notify.maxPerCycle || 5;
  const list = drops.slice(0, max);

  for (const d of list) {
    const pct = d.pct ? ` (-${d.pct}%)` : '';
    const from = d.prevPrice !== null && d.prevPrice !== undefined ? `$${d.prevPrice} → ` : '';
    await notify({
      title: d.type === 'target' ? '已到目标价！' : '降价了',
      body: `${d.name}\n${from}$${d.price}${pct}`,
      launchUrl: d.url,
      sound: !!settings.notify.sound,
    });
  }

  if (drops.length > list.length) {
    await notify({
      title: `还有 ${drops.length - list.length} 条降价`,
      body: '打开 Best Buy 降价雷达查看完整历史记录',
      sound: false,
    });
  }
}

export async function pingNotify() {
  if (os.platform() !== 'win32') return { ok: false, detail: '非 Windows 系统，桌面通知不可用' };
  const ok = await notify({
    title: 'Best Buy 降价雷达',
    body: '通知通道正常，降价时你会在这里收到提醒。',
  });
  return { ok, detail: ok ? '测试通知已发送' : '发送失败，请检查系统通知权限（设置 → 系统 → 通知）' };
}
