/**
 * 实例标识：让控制脚本能可靠地找到"我们这个"服务进程。
 *
 * 光靠端口或者 `taskkill /im node.exe` 都不行——这台机器上可能同时跑着
 * 别的 node 程序（之前就误杀过隔壁项目的服务）。所以服务启动时写一个
 * pid 文件，里面记 pid、端口和一个随机 token；控制脚本据此确认
 * "这个进程确实是我，端口上答话的也确实是我"，再动手。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const PID_FILE = path.join(DATA_DIR, 'server.pid');

export function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

export function writePidFile(info) {
  const data = { pid: process.pid, startedAt: Date.now(), ...info };
  try {
    fs.writeFileSync(PID_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* 写不了就算了，控制脚本还有按端口探测的兜底 */
  }
  return data;
}

export function readPidFile() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data.pid === 'number' ? data : null;
  } catch {
    return null;
  }
}

export function clearPidFile() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* 本来就没有 */
  }
}

/** 进程还活着吗（signal 0 只探测不发信号） */
export function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但没权限发信号，也算活着
    return e.code === 'EPERM';
  }
}
