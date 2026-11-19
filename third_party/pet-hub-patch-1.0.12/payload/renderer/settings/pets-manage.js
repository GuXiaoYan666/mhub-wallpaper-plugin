'use strict';

// 宠物包管理（删除 / 导入）的纯逻辑：只做字符串与结构判断，不碰 DOM 也不碰 fs，
// 这样设置页只负责事件与 IO，探针可以在 Node 里直接 require 这份模块做断言。
// 规则来源：lib/pets.js 的 ID_PATTERN、codex-pet-installer 的 slug 规则（npm 包 0.1.1 源码）。
(function (root, factory) {
  const api = factory();
  if (root) root.petManage = api;
  // 只在真正的 CommonJS 环境里写 module.exports：页面里如果存在模块垫片（设置页探针会注入 window.module），
  // 直接写会把垫片的导出槽顶掉（i18n 就是这样被顶掉的），所以用 require.resolve 判断是不是真的 Node require。
  if (typeof module === 'object' && module && module.exports && typeof require === 'function' && typeof require.resolve === 'function') {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  // 与 lib/pets.js:9 的 ID_PATTERN 保持一致：禁止路径分隔符与点点，避免删除/写入越权。
  const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
  // codex-pet-installer@0.1.1 src/installer.js 的 slugPattern：只允许小写与单连字符。
  const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const LONG_PRESS_MS = 520;
  const MOVE_TOLERANCE_PX = 8;
  const MANIFEST = 'pet.json';
  const SHEET_CANDIDATES = ['spritesheet.webp', 'spritesheet.png', 'spritesheet.jpg', 'spritesheet.jpeg', 'spritesheet.gif'];
  const NPX_PACKAGE = 'codex-pet-installer';

  function isSafeId(id) {
    return typeof id === 'string' && ID_PATTERN.test(id);
  }

  function isSafeSlug(slug) {
    return typeof slug === 'string' && SLUG_PATTERN.test(slug);
  }

  // webkitRelativePath 的第一段就是用户选中的文件夹名，用它兜底成宠物 id。
  function folderNameOf(relPath) {
    const text = String(relPath || '').replace(/\\/g, '/');
    const head = text.split('/')[0];
    return head && head !== '.' ? head : '';
  }

  function idFromFolderName(name) {
    const cleaned = String(name || '').trim().replace(/\s+/g, '-');
    return isSafeId(cleaned) ? cleaned : '';
  }

  // files: [{ rel: 'aby/pet.json', size: 123 }]，来自 <input webkitdirectory> 的 webkitRelativePath。
  // 只做结构判断：根目录是否有 pet.json、是否有 spritesheet、id 是否合法、文件是否都在同一个根下。
  function scanSelection(files, options) {
    const opts = options || {};
    const list = Array.isArray(files) ? files : [];
    const result = { ok: false, root: '', id: '', files: [], sheet: '', manifest: '', error: '' };
    if (!list.length) {
      result.error = 'empty';
      return result;
    }
    const root = folderNameOf(list[0].rel);
    if (!root) {
      result.error = 'no-root';
      return result;
    }
    // 根目录名只允许是普通文件夹名：出现 .. 或路径分隔符说明 rel 被构造过（越权），直接判死。
    if (root === '.' || root.indexOf('..') >= 0 || root.indexOf('/') >= 0 || root.indexOf('\\') >= 0) {
      result.error = 'bad-path';
      return result;
    }
    // 用户选了文件夹里的单个文件时，webkitRelativePath 没有子路径，也就没有根目录可复制。
    if (String(list[0].rel || '').replace(/\\/g, '/').indexOf('/') < 0) {
      result.error = 'no-root';
      return result;
    }
    const entries = [];
    for (let i = 0; i < list.length; i += 1) {
      const rel = String(list[i].rel || '').replace(/\\/g, '/');
      if (!rel || rel.indexOf(root + '/') !== 0) {
        result.error = 'multi-root';
        return result;
      }
      const inner = rel.slice(root.length + 1);
      if (!inner || inner.indexOf('..') >= 0) {
        result.error = 'bad-path';
        return result;
      }
      entries.push({ rel: inner, abs: list[i].abs || '', size: Number(list[i].size) || 0 });
    }
    const manifest = entries.find(function (entry) { return entry.rel === MANIFEST; });
    if (!manifest) {
      result.error = 'no-manifest';
      return result;
    }
    const sheet = entries.find(function (entry) {
      return SHEET_CANDIDATES.indexOf(entry.rel.toLowerCase()) >= 0;
    });
    if (!sheet) {
      result.error = 'no-spritesheet';
      return result;
    }
    let manifestId = '';
    if (typeof opts.manifestText === 'string' && opts.manifestText) {
      try {
        const parsed = JSON.parse(opts.manifestText);
        if (parsed && typeof parsed.id === 'string') manifestId = parsed.id.trim();
      } catch (err) {
        result.error = 'bad-manifest';
        return result;
      }
    }
    const id = manifestId || idFromFolderName(root);
    if (!isSafeId(id)) {
      result.error = 'bad-id';
      return result;
    }
    result.ok = true;
    result.root = root;
    result.id = id;
    result.files = entries;
    result.sheet = sheet.rel;
    result.manifest = manifest.rel;
    return result;
  }

  // Parse supported download channels; the main process fetches assets, never runs npm.
  const CHANNELS = {
    'codex-pet-installer': { verbs: ['add'], slug: SLUG_PATTERN },
    clipets: { verbs: ['install', 'i', 'add'], slug: /^[a-z0-9]+(?:-+[a-z0-9]+)*$/ },
    petscodex: { verbs: ['install'], slug: /^[a-z0-9]+(?:-+[a-z0-9]+)*$/ },
    petdex: { verbs: ['install', 'i', 'add'], slug: /^[a-z0-9]+(?:-+[a-z0-9]+)*$/ }
  };
  function parseNpxCommand(text) {
    const raw = String(text || '').trim();
    const out = { ok: false, slug: '', args: [], error: '' };
    if (!raw) {
      out.error = 'empty';
      return out;
    }
    const tokens = raw.split(/\s+/).filter(Boolean);
    const head = (tokens[0] || '').toLowerCase();
    if (head !== 'npx' && head !== 'npm') {
      out.error = 'not-npx';
      return out;
    }
    let rest = tokens.slice(1);
    if (head === 'npm') {
      if ((rest[0] || '').toLowerCase() !== 'exec') {
        out.error = 'not-npx';
        return out;
      }
      rest = rest.slice(1);
    }
    while (rest[0] === '-y' || rest[0] === '--yes' || rest[0] === '--') rest.shift();
    const pkg = rest.shift() || '';
    const match = /^(codex-pet-installer|clipets|petscodex|petdex)(?:@([A-Za-z0-9][A-Za-z0-9._-]*))?$/.exec(pkg);
    const name = match && match[1];
    const channel = name && CHANNELS[name];
    if (!channel) {
      out.error = 'unknown-package';
      return out;
    }
    if (rest[0] === '--') rest.shift();
    if (channel.verbs.indexOf((rest[0] || '').toLowerCase()) < 0) {
      out.error = 'bad-command';
      return out;
    }
    const slug = (rest[1] || '').trim().toLowerCase();
    if (slug.length > 128 || !channel.slug.test(slug)) {
      out.error = 'bad-slug';
      return out;
    }
    if (rest.length > 2) {
      out.error = 'bad-command';
      return out;
    }
    out.ok = true;
    out.provider = name;
    out.slug = slug;
    out.args = ['-y', name, channel.verbs[0], slug];
    return out;
  }

  // npx 调用的进程形状。args 数组 + shell:false 是硬要求：
  //   · Windows 上 .cmd 无法在 shell:false 下直接 spawn（Node ≥20.12 会拒绝），所以走 ComSpec /d /s /c；
  //   · 命令串只由白名单 token 拼出（parseNpxCommand 保证是 -y / codex-pet-installer / add / slug），
  //     任何不合规 token 都让整个计划返回 null，绝不做转义后的自由拼接。
  const SAFE_ARG = /^[A-Za-z0-9@/._-]+$/;
  function spawnPlan(argv, platform, comspec) {
    const args = Array.isArray(argv) ? argv.map(function (item) { return String(item); }) : [];
    if (!args.length) return null;
    for (let i = 0; i < args.length; i += 1) {
      if (!SAFE_ARG.test(args[i])) return null;
    }
    if (platform === 'win32') {
      return { file: comspec || 'cmd.exe', args: ['/d', '/s', '/c', args.join(' ')], shell: false };
    }
    return { file: 'npx', args: args, shell: false };
  }

  // 安装器把宠物写到 <CODEX_HOME>/pets/<id>（见 codex-pet-installer src/installer.js），
  // 所以把 CODEX_HOME 指到 pets 的父目录，npx 装完就正好落在本插件的 pets 目录里。
  function codexHomeFor(petsDir) {
    const text = String(petsDir || '').replace(/[\\/]+$/, '');
    const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    return cut > 0 ? text.slice(0, cut) : text;
  }

  function guardDelete(id) {
    if (!isSafeId(id)) return { ok: false, error: 'bad-id' };
    if (id === '.' || id === '..') return { ok: false, error: 'bad-id' };
    return { ok: true, error: '' };
  }

  // fs 错误码 -> 给用户看的原因，设置页据此选 i18n 文案。
  function errorReason(err) {
    const code = err && err.code ? String(err.code) : '';
    if (code === 'EPERM' || code === 'EACCES') return 'no-permission';
    if (code === 'ENOENT') return 'not-found';
    if (code === 'EBUSY' || code === 'ENOTEMPTY') return 'busy';
    if (code === 'ENOSPC') return 'no-space';
    if (code === 'ENOTDIR') return 'not-folder';
    return 'unknown';
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    return (value / 1024 / 1024).toFixed(1) + ' MB';
  }

  return {
    ID_PATTERN: ID_PATTERN,
    SLUG_PATTERN: SLUG_PATTERN,
    LONG_PRESS_MS: LONG_PRESS_MS,
    MOVE_TOLERANCE_PX: MOVE_TOLERANCE_PX,
    NPX_PACKAGE: NPX_PACKAGE,
    MANIFEST: MANIFEST,
    SHEET_CANDIDATES: SHEET_CANDIDATES,
    isSafeId: isSafeId,
    isSafeSlug: isSafeSlug,
    folderNameOf: folderNameOf,
    idFromFolderName: idFromFolderName,
    scanSelection: scanSelection,
    parseNpxCommand: parseNpxCommand,
    codexHomeFor: codexHomeFor,
    spawnPlan: spawnPlan,
    guardDelete: guardDelete,
    errorReason: errorReason,
    formatBytes: formatBytes
  };
});
