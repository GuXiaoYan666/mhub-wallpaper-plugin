(function () {
  'use strict';

  // GPU 精灵层：只负责把图集帧画出来（可插值），HUD 仍留在 2D 画布上。
  // 高清 v2 不再走这里：放大图集由 2D canvas 1:1 贴图，拉普拉斯锐化 pass 已删除。
  const VERT = [
    'attribute vec2 aPos;',
    'uniform vec4 uQuad;',
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = vec2(aPos.x, 1.0 - aPos.y);',
    '  gl_Position = vec4(mix(uQuad.xy, uQuad.zw, aPos), 0.0, 1.0);',
    '}'
  ].join('\n');

  const FRAG_TEX = [
    'precision mediump float;',
    'uniform sampler2D uTex;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec4 c = texture2D(uTex, vUv);',
    '  gl_FragColor = vec4(c.rgb * c.a, c.a);',
    '}'
  ].join('\n');

  // 补帧：全局平移优先。整只宠物共用一条位移矢量 uShift，
  // 只有置信度达标的块才做本地位移，其余像素退回 mix(A, B, t)。
  const FRAG_SPRITE = [
    'precision mediump float;',
    'uniform sampler2D uAtlas;',
    'uniform sampler2D uConf;',
    'uniform vec4 uRectA;',
    'uniform vec4 uRectB;',
    'uniform vec2 uAtlasSize;',
    'uniform vec2 uFrameSize;',
    'uniform vec2 uGrid;',
    'uniform vec2 uShift;',
    'uniform float uBlock;',
    'uniform float uConfMin;',
    'uniform float uT;',
    'uniform float uInterp;',
    'varying vec2 vUv;',
    'vec2 sampleAt(vec2 origin, vec2 p) {',
    '  vec2 q = clamp(p, vec2(0.5), uFrameSize - vec2(0.5));',
    '  return origin + q / uAtlasSize;',
    '}',
    'void main() {',
    '  vec2 p = vUv * uFrameSize;',
    '  float t = uT;',
    '  vec2 shift = vec2(0.0);',
    '  if (uInterp > 0.5) {',
    '    vec2 fuv = (p / uBlock + 0.5) / uGrid;',
    '    if (texture2D(uConf, fuv).r >= uConfMin) shift = uShift;',
    '  }',
    '  vec4 ca = texture2D(uAtlas, sampleAt(uRectA.xy, p - shift * t));',
    '  vec4 cb = ca;',
    '  if (uInterp > 0.5 && t > 0.002) cb = texture2D(uAtlas, sampleAt(uRectB.xy, p + shift * (1.0 - t)));',
    // The atlas is uploaded premultiplied so linear filtering preserves transparent edges.
    '  vec4 c = mix(ca, cb, t);',
    '  if (c.a <= 0.0) discard;',
    '  gl_FragColor = c;',
    '}'
  ].join('\n');

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('shader alloc failed');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('shader compile failed: ' + log);
    }
    return shader;
  }

  function build(gl, fragment) {
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
    const program = gl.createProgram();
    if (!program) throw new Error('program alloc failed');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error('link failed: ' + log);
    }
    return { program: program, cache: {}, quad: null, pos: gl.getAttribLocation(program, 'aPos') };
  }

  function loc(gl, unit, name) {
    if (Object.prototype.hasOwnProperty.call(unit.cache, name)) return unit.cache[name];
    const found = gl.getUniformLocation(unit.program, name);
    unit.cache[name] = found;
    return found;
  }

  function texture(gl, unit) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  function create(canvas) {
    const attrs = {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false
    };
    const gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    if (!gl) return null;

    const state = {
      lost: false,
      width: 0,
      height: 0,
      atlas: null,
      atlasW: 1,
      atlasH: 1,
      atlasTooBig: false,
      confReady: false,
      grid: [1, 1],
      block: 16,
      shift: [0, 0],
      confMin: 0.55,
      glow: null,
      glowW: 0,
      glowH: 0
    };

    // R2：图集尺寸上限要能在建图集之前被问到，所以查询结果缓存一份给渲染层预判用。
    // （声明提前到资源初始化之前：上下文恢复时要把它清掉重新问。）
    let maxTexCache = -1;

    let texProgram;
    let spriteProgram;
    let buffer;
    const restoreHooks = [];
    let restoreCount = 0;

    // R10：所有 GL 资源收敛到一个可重入函数里。上下文丢失后旧程序/纹理全部作废，
    // restored 事件里整块重建；尺寸与置信度状态回落到「未上传」，由渲染层重新推送。
    function initResources() {
      texProgram = build(gl, FRAG_TEX);
      spriteProgram = build(gl, FRAG_SPRITE);

      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

      const atlasTex = texture(gl, 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      // 置信度贴图按块取整，不能被线性过滤糊化
      const confTex = texture(gl, 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const glowTex = texture(gl, 2);
      state.atlas = atlasTex;
      state.conf = confTex;
      state.glow = glowTex;
      state.lost = false;
      state.atlasW = 1;
      state.atlasH = 1;
      state.atlasTooBig = false;
      state.confReady = false;
      state.glowW = 0;
      state.glowH = 0;
      maxTexCache = -1;
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
    }

    canvas.addEventListener('webglcontextlost', function (event) {
      event.preventDefault();
      state.lost = true;
    }, false);

    canvas.addEventListener('webglcontextrestored', function () {
      // R10：丢失是可重试的——重建程序/缓冲/纹理，复位尺寸状态，再让渲染层把内容推回来。
      try {
        initResources();
      } catch (err) {
        console.warn('[pet] webgl restored but re-init failed', err);
        state.lost = true;
        return;
      }
      restoreCount += 1;
      for (let i = 0; i < restoreHooks.length; i += 1) {
        try {
          restoreHooks[i](gl);
        } catch (err) {
          // 单个回调失败不影响其它回调与后续渲染
        }
      }
    }, false);

    try {
      initResources();
    } catch (err) {
      return null;
    }
    function instanceMaxTexture() {
      if (maxTexCache >= 0) return maxTexCache;
      let value = 0;
      try {
        value = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
      } catch (err) {
        value = 0;
      }
      maxTexCache = value;
      return value;
    }

    function bindAttrib(unit) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(unit.pos);
      gl.vertexAttribPointer(unit.pos, 2, gl.FLOAT, false, 0, 0);
    }

    function draw(unit, quad) {
      gl.useProgram(unit.program);
      gl.uniform4f(loc(gl, unit, 'uQuad'), quad[0], quad[1], quad[2], quad[3]);
      bindAttrib(unit);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    const api = {
      canvas: canvas,

      get lost() {
        return state.lost;
      },

      get atlasTooBig() {
        return state.atlasTooBig === true;
      },

      // R2：本实例真实上下文的上限，供 pet.js 在建图集前预判
      maxTexture: instanceMaxTexture,

      // R10：上下文恢复通知。渲染层在这里把图集/光流/光效重新推给新纹理，并复位降级结论。
      onRestore: function (fn) {
        if (typeof fn === 'function') restoreHooks.push(fn);
        return api;
      },

      // R10：成功重建过几次（验收用，只增不删）
      get restores() {
        return restoreCount;
      },

      // R13：已提交纹理的真实尺寸（超限被拒时不变），供验收断言
      get atlasSize() {
        return [state.atlasW, state.atlasH];
      },

      setSize: function (width, height) {
        if (!(width > 0) || !(height > 0)) return;
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        state.width = width;
        state.height = height;
      },

      setAtlas: function (image) {
        if (!image) return;
        // 图集可能是 HTMLImageElement（缓存命中）或 canvas/ImageBitmap（现场构建），尺寸取值要都覆盖
        const w = image.naturalWidth || image.width || 0;
        const h = image.naturalHeight || image.height || 0;
        if (!(w > 0) || !(h > 0)) return;
        // R13：先判上限再写 atlasW/H——超限时不能留下与真实纹理不符的尺寸（原顺序会让采样坐标按新尺寸算、纹理却是旧的）。
        // GPU 纹理上限装不下就先别传：保留旧纹理，由调用方回落到 2D 绘制（可见性优先）
        const maxTex = instanceMaxTexture();
        if (maxTex > 0 && (w > maxTex || h > maxTex)) {
          state.atlasTooBig = true;
          return;
        }
        state.atlasW = w;
        state.atlasH = h;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, state.atlas);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image); }
        finally { gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); }
        state.atlasTooBig = false;
      },

      setFlow: function (data) {
        if (!data || !data.conf) {
          state.confReady = false;
          return;
        }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, state.conf);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, data.cols, data.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data.conf);
        state.confReady = true;
        state.grid = [data.cols, data.rows];
        state.block = data.block;
        state.shift = data.shift || [0, 0];
        state.confMin = typeof data.confMin === 'number' ? data.confMin : 0.55;
      },

      setGlow: function (source) {
        if (!source) {
          state.glowW = 0;
          state.glowH = 0;
          return;
        }
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, state.glow);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        state.glowW = source.width;
        state.glowH = source.height;
      },

      render: function (frame) {
        if (state.lost || !state.width || !state.height) return false;
        const width = state.width;
        const height = state.height;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        if (state.glowW) {
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, state.glow);
          gl.useProgram(texProgram.program);
          gl.uniform1i(loc(gl, texProgram, 'uTex'), 2);
          draw(texProgram, [-1, -1, 1, 1]);
        }

        const ready = frame && frame.frameA && state.atlasW > 1;
        if (!ready) return true;

        const logicalH = frame.logicalH || 328;
        // 位图格高与逻辑帧高是两件事：高清图集里一格是设备像素，舞台仍是 328 逻辑像素。
        const bitH = frame.frameH || 208;
        const logicalFrameH = frame.logicalFrameH || bitH;
        const top = frame.frameY - (frame.jump || 0);
        const clipTop = 1 - 2 * top / logicalH;
        const clipBottom = 1 - 2 * (top + logicalFrameH) / logicalH;
        const quad = [-1, clipBottom, 1, clipTop];

        const useInterp = !!(frame.interp && state.confReady && frame.t > 0);
        const unit = spriteProgram;
        gl.useProgram(unit.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, state.atlas);
        gl.uniform1i(loc(gl, unit, 'uAtlas'), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, state.conf);
        gl.uniform1i(loc(gl, unit, 'uConf'), 1);
        gl.uniform4f(loc(gl, unit, 'uRectA'), frame.frameA.x / state.atlasW, frame.frameA.y / state.atlasH, 0, 0);
        const b = frame.frameB || frame.frameA;
        gl.uniform4f(loc(gl, unit, 'uRectB'), b.x / state.atlasW, b.y / state.atlasH, 0, 0);
        gl.uniform2f(loc(gl, unit, 'uAtlasSize'), state.atlasW, state.atlasH);
        gl.uniform2f(loc(gl, unit, 'uFrameSize'), frame.frameW || 192, bitH);
        gl.uniform2f(loc(gl, unit, 'uGrid'), state.grid[0], state.grid[1]);
        gl.uniform2f(loc(gl, unit, 'uShift'), state.shift[0], state.shift[1]);
        gl.uniform1f(loc(gl, unit, 'uBlock'), state.block);
        gl.uniform1f(loc(gl, unit, 'uConfMin'), state.confMin);
        gl.uniform1f(loc(gl, unit, 'uT'), useInterp ? frame.t : 0);
        gl.uniform1f(loc(gl, unit, 'uInterp'), useInterp ? 1 : 0);
        draw(unit, quad);
        return true;
      },

      dispose: function () {
        try {
          const lose = gl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
        } catch (err) {
          return;
        }
      }
    };

    return api;
  }

  // R2：不依赖 live 实例的纹理上限查询——建图集之前就要知道能建多大。
  // 有 live 实例时调用方应优先用 instance.maxTexture()（那是真实上下文），这里只是兜底探针。
  let probeMaxTexture = -1;
  function maxTexture() {
    if (probeMaxTexture >= 0) return probeMaxTexture;
    let value = 0;
    try {
      if (typeof document !== 'undefined' && document.createElement) {
        const probe = document.createElement('canvas');
        probe.width = 1;
        probe.height = 1;
        const probeGl = probe.getContext('webgl') || probe.getContext('experimental-webgl');
        if (probeGl) {
          value = probeGl.getParameter(probeGl.MAX_TEXTURE_SIZE) || 0;
          // 探针用完立刻释放，避免占掉浏览器有限的上下文配额
          const lose = probeGl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
        }
      }
    } catch (err) {
      value = 0;
    }
    probeMaxTexture = value;
    return value;
  }

  window.PetFx = { create: create, maxTexture: maxTexture };
})();
