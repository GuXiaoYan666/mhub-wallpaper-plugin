'use strict';

const { imageSize, validateImage } = require('./image-size.js');

// The header is only a cheap size gate. Chromium must decode the complete asset
// before it can enter the library; nativeImage alone cannot decode every WebP.
function createValidator(electron) {
  return async function validate(bytes, hero) {
    if (!validateImage(bytes, hero)) return false;
    const expected = imageSize(bytes);
    if (!electron || !electron.BrowserWindow) throw Object.assign(new Error('image decoder unavailable'), { code: 'decoder-unavailable' });
    let win, timer;
    try {
      win = new electron.BrowserWindow({ show: false, width: 1, height: 1, skipTaskbar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
      const decode = (async () => {
        await win.loadURL('data:text/html,<meta charset="utf-8">');
        const data = 'data:application/octet-stream;base64,' + bytes.toString('base64');
        return win.webContents.executeJavaScript('(async()=>{try{const image=new Image();image.src=' + JSON.stringify(data) + ';await image.decode();return {width:image.naturalWidth,height:image.naturalHeight};}catch(_){return null;}})()');
      })();
      const result = await Promise.race([decode, new Promise(resolve => { timer = setTimeout(() => resolve(null), 15000); })]);
      return !!result && result.width === expected.width && result.height === expected.height;
    } finally { clearTimeout(timer); if (win && !win.isDestroyed()) win.destroy(); }
  };
}

async function validateImageFully(bytes, hero) {
  let electron; try { electron = require('electron'); } catch (_) {}
  return createValidator(electron)(bytes, hero);
}
module.exports = { createValidator, validateImageFully };
