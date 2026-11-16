'use strict';
// 系统指标采集：CPU 占用（os.cpus 时间增量）、内存、开机时长、系统盘剩余空间。
// 全部来自 Node 内置模块；fs.statfs 在旧版 Node 缺失时优雅降级。

const os = require('os');
const fs = require('fs');

const HIST_LEN = 60;

function pct(total, idle) {
  const t = total - idle;
  if (!(t > 0)) return 0;
  return Math.max(0, Math.min(100, (t / total) * 100));
}

function pushHist(arr, v, max) {
  arr.push(v);
  const cap = max || HIST_LEN;
  while (arr.length > cap) arr.shift();
}

function createCollector(options) {
  const logger = options && options.logger;
  const state = {
    lastCpus: null,
    lastAt: 0,
    cpuPct: 0,
    cpuHist: [],
    memHist: [],
    disk: null,
    disks: null,
    diskAt: 0,
    statfsFn: typeof fs.statfs === 'function' ? fs.statfs : (fs.statfsSync ? null : null)
  };

  function sampleCpu() {
    const cpus = os.cpus();
    if (!cpus || !cpus.length) return;
    let total = 0, idle = 0;
    for (let i = 0; i < cpus.length; i++) {
      const t = cpus[i].times;
      total += (t.user + t.nice + t.sys + t.idle + t.irq);
      idle += t.idle;
    }
    if (state.lastCpus) {
      const dTotal = total - state.lastCpus.total;
      const dIdle = idle - state.lastCpus.idle;
      if (dTotal >= 0 && dIdle >= 0) {
        state.cpuPct = pct(dTotal, dIdle);
        pushHist(state.cpuHist, Math.round(state.cpuPct));
      }
    }
    state.lastCpus = { total: total, idle: idle };
  }

  function sampleDisk() {
    const now = Date.now();
    if (state.disk && now - state.diskAt < 10 * 60 * 1000) return;
    try {
      const statfsFn = typeof fs.statfsSync === 'function' ? fs.statfsSync : null;
      if (!statfsFn) return;
      const drives = [];
      // 系统盘 + 常见本地盘符探测（存在即纳入，最多 4 块）
      const letters = [process.env.SystemDrive || 'C:', 'D:', 'E:', 'F:'];
      const seen = {};
      for (let i = 0; i < letters.length && drives.length < 4; i++) {
        let drive = String(letters[i] || '').replace(/\\$/, '').toUpperCase();
        if (!/^[A-Z]:$/.test(drive) || seen[drive]) continue;
        seen[drive] = true;
        try {
          const st = statfsFn(drive + '\\');
          if (st && st.blocks > 0) {
            const bsize = st.bsize || 4096;
            const total = st.blocks * bsize;
            const free = st.bfree * bsize;
            drives.push({
              drive: drive,
              totalBytes: total,
              freeBytes: free,
              usedPct: total > 0 ? Math.round(((total - free) / total) * 100) : 0
            });
          }
        } catch (e) { /* 盘符不存在或不可读 */ }
      }
      if (drives.length) {
        state.disk = drives[0];
        state.disks = drives;
        state.diskAt = now;
      }
    } catch (e) {
      if (logger) logger.debug('disk statfs failed: ' + (e && e.message));
    }
  }

  function sample() {
    sampleCpu();
    sampleDisk();
  }

  function snapshot() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const used = totalMem - freeMem;
    const memPct = totalMem > 0 ? (used / totalMem) * 100 : 0;
    pushHist(state.memHist, Math.round(memPct));
    const upS = Math.max(0, Math.floor(os.uptime()));
    return {
      cpuPct: Math.round(state.cpuPct),
      cpuHist: state.cpuHist.slice(),
      cpuCores: (os.cpus() || []).length || 0,
      cpuModel: (os.cpus() && os.cpus()[0] && os.cpus()[0].model || '').replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').trim().slice(0, 40),
      memUsedBytes: used,
      memTotalBytes: totalMem,
      memPct: Math.round(memPct),
      memHist: state.memHist.slice(),
      uptimeSec: upS,
      disk: state.disk,
      disks: state.disks ? state.disks.slice() : (state.disk ? [state.disk] : null),
      host: (os.hostname() || '').slice(0, 32),
      platform: os.platform() + ' ' + os.release()
    };
  }

  function start() {
    state.lastCpus = null;
    sample();
    // 第一次采样只建立基线，第二个采样点才有真实 CPU 百分比。
    setImmediate(function () { try { sample(); } catch (e) { /* ignore */ } });
  }

  function stop() { state.lastCpus = null; }

  return { start: start, stop: stop, sample: sample, snapshot: snapshot };
}

module.exports = { createCollector: createCollector };
