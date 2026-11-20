'use strict';

/* 最后的下载兜底：调用系统自带的 curl.exe（Windows 10+ 自带，走 schannel，
   使用 Windows 根证书与系统代理）。个别机器 Electron/Node 的证书链校验失败时，
   curl 往往还能正常下载。仅在前面两种方式都失败后调用。 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function downloadWithCurl(url, limit, context = {}) {
  return new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), 'mhub-pet-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.bin');
    const args = ['-L', '--fail', '--silent', '--show-error', '--max-time', '120', '-A', 'MCHOSE-Pet-Hub', '-o', file, url];
    execFile('curl.exe', args, { windowsHide: true, timeout: 130000 }, async error => {
      try {
        if (context && context.signal && context.signal.aborted) {
          reject(Object.assign(new Error('pet download: cancelled ' + url), { code: 'cancelled' }));
          return;
        }
        if (error) {
          const failure = new Error('pet download: network ' + url);
          failure.code = 'network';
          failure.cause = error;
          reject(failure);
          return;
        }
        const stat = await fs.promises.stat(file);
        if (stat.size > limit) {
          reject(Object.assign(new Error('pet download: too-large ' + url), { code: 'too-large' }));
          return;
        }
        resolve(await fs.promises.readFile(file));
      } catch (cause) {
        const failure = new Error('pet download: network ' + url);
        failure.code = 'network';
        failure.cause = cause;
        reject(failure);
      } finally {
        fs.promises.unlink(file).catch(() => {});
      }
    });
  });
}

module.exports = { downloadWithCurl: downloadWithCurl };
