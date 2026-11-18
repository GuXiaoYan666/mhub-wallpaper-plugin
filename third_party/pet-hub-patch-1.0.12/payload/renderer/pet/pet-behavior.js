(function (factory) {
  const api = factory();
  if (typeof window !== 'undefined') window.PetBehavior = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(function () {
  'use strict';

  // 契约 §3：数值越小优先级越高；P0（拖拽）占用期间 P1–P4 排队，队列上限 4，ttlMs 到期丢弃。
  const AMBIENT_PRIORITY = 4;
  const PRIORITY_MIN = 0;
  const PRIORITY_MAX = 4;
  const QUEUE_MAX = 4;
  const DEFAULT_TTL_MS = 2500;
  const DEFAULT_ONE_SHOT_MS = 800;
  // 契约 §3/§9 的「一次性动作」：播完回 idle 或回到被打断的持续态。
  const ONE_SHOT_ACTIONS = ['waving', 'jumping', 'failed'];
  const RESTORE_ACTIONS = ['idle', 'running-left', 'running-right'];
  // 契约 §6：双击窗口、连点计数、悬停阈值。
  const DOUBLE_MS = 250;
  const BURST_SPAN_MS = 4000;
  const BURST_MAX = 5;
  const HOVER_MS = 600;
  const HOVER_COOLDOWN_MS = 600;

  function isOneShot(action) {
    return ONE_SHOT_ACTIONS.indexOf(String(action)) >= 0;
  }

  function clampPriority(value) {
    const raw = Number(value);
    if (!isFinite(raw)) return AMBIENT_PRIORITY;
    return Math.max(PRIORITY_MIN, Math.min(PRIORITY_MAX, Math.round(raw)));
  }

  function create(options) {
    const deps = options || {};
    const startAction = typeof deps.start === 'function' ? deps.start : function () {};
    const baseAction = typeof deps.baseAction === 'function' ? deps.baseAction : function () { return 'idle'; };
    const durationOf = typeof deps.durationOf === 'function' ? deps.durationOf : null;
    const onDone = typeof deps.onDone === 'function' ? deps.onDone : function () {};
    const onAction = typeof deps.onAction === 'function' ? deps.onAction : function () {};
    const clock = typeof deps.now === 'function' ? deps.now : function () { return 0; };
    const settingsOf = typeof deps.getSettings === 'function' ? deps.getSettings : function () { return {}; };

    const model = {
      current: 'idle',
      // R12：priority 只记真实档位；持续态的环境压制单独放在 ambientLevel，比较时取生效的那个。
      priority: AMBIENT_PRIORITY,
      ambientLevel: AMBIENT_PRIORITY,
      kind: 'base',
      since: 0,
      base: 'idle',
      oneShot: null,
      queue: [],
      busy: false,
      lastEvent: null,
      hoverAt: -1,
      hoverFired: false,
      hoverCoolUntil: 0,
      burstAt: 0,
      burstCount: 0,
      pendingClick: 0
    };

    function nowOf(value) {
      if (typeof value === 'number' && isFinite(value)) return value;
      const at = Number(clock());
      return isFinite(at) ? at : 0;
    }

    function quiet() {
      const settings = settingsOf();
      return !!settings && settings.quietMode === true;
    }

    function restoreAction() {
      return RESTORE_ACTIONS.indexOf(model.base) >= 0 ? model.base : 'idle';
    }

    function normalize(raw, at) {
      if (!raw || typeof raw !== 'object') return null;
      const action = typeof raw.action === 'string' ? raw.action : '';
      if (!action) return null;
      const oneShot = raw.oneShot === true || (raw.oneShot !== false && isOneShot(action));
      let durationMs = Number(raw.durationMs);
      if (!isFinite(durationMs) || durationMs <= 0) durationMs = durationOf ? Number(durationOf(action)) : 0;
      if (!isFinite(durationMs) || durationMs <= 0) durationMs = DEFAULT_ONE_SHOT_MS;
      let ttlMs = Number(raw.ttlMs);
      if (!isFinite(ttlMs) || ttlMs <= 0) ttlMs = DEFAULT_TTL_MS;
      return {
        id: typeof raw.id === 'string' ? raw.id : '',
        kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : 'event',
        action: action,
        priority: clampPriority(raw.priority),
        oneShot: oneShot,
        critical: raw.critical === true,
        ttlMs: ttlMs,
        durationMs: Math.max(120, durationMs),
        transient: raw.transient === true,
        internal: raw.internal === true,
        source: typeof raw.source === 'string' ? raw.source : 'local',
        at: at
      };
    }

    function record(event, result) {
      model.lastEvent = {
        at: event ? event.at : nowOf(),
        kind: event ? event.kind : 'none',
        action: event ? event.action : '',
        priority: event ? event.priority : -1,
        result: result,
        id: event ? event.id : ''
      };
      return model.lastEvent;
    }

    function purge(at) {
      if (!model.queue.length) return;
      model.queue = model.queue.filter(function (item) { return at - item.at <= item.ttlMs; });
    }

    function enqueue(event, at) {
      for (let i = 0; i < model.queue.length; i += 1) {
        // 同类事件以最新值为准：同 kind 同优先级时覆盖而不是再占一条。
        if (model.queue[i].kind === event.kind && model.queue[i].priority === event.priority) {
          model.queue[i] = event;
          return true;
        }
      }
      if (model.queue.length >= QUEUE_MAX) {
        let worst = 0;
        for (let i = 1; i < model.queue.length; i += 1) {
          if (model.queue[i].priority > model.queue[worst].priority) worst = i;
        }
        if (event.priority > model.queue[worst].priority) return false;
        model.queue[worst] = event;
        return true;
      }
      model.queue.push(event);
      return true;
    }

    function adopt(event, at) {
      const previous = model.current;
      const preempted = previous !== event.action;
      model.current = event.action;
      model.priority = event.priority;
      // 持续态（idle/漫游/跟手/自动演出）按环境行为占用，避免 P0/P1 的持续占用把后续事件全堵死；
      // R12：这层压制放在 ambientLevel，不覆盖 priority 里的真实档位。
      model.ambientLevel = AMBIENT_PRIORITY;
      model.kind = event.kind;
      model.since = at;
      if (event.oneShot) {
        model.oneShot = { action: event.action, until: at + event.durationMs, restore: restoreAction() };
      } else {
        model.oneShot = null;
        if (!event.transient) model.base = event.action;
      }
      const meta = {
        kind: event.kind,
        priority: event.priority,
        oneShot: event.oneShot,
        transient: event.transient,
        critical: event.critical,
        source: event.source,
        id: event.id,
        internal: event.internal,
        preempted: preempted ? previous : ''
      };
      startAction(event.action, event.oneShot, meta);
      onAction(event.action, meta);
      return meta;
    }

    // R12：一次性动作按真实档位比较，持续态按环境档压制。
    function gateLevel() {
      return model.oneShot ? model.priority : model.ambientLevel;
    }

    function drain(at) {
      if (model.busy) return;
      let guard = 0;
      while (model.queue.length && guard < 8) {
        guard += 1;
        let best = 0;
        for (let i = 1; i < model.queue.length; i += 1) {
          if (model.queue[i].priority < model.queue[best].priority) best = i;
          else if (model.queue[i].priority === model.queue[best].priority && model.queue[i].at < model.queue[best].at) best = i;
        }
        const event = model.queue.splice(best, 1)[0];
        if (at - event.at > event.ttlMs) {
          record(event, 'expired');
          continue;
        }
        if (event.priority > gateLevel()) {
          record(event, 'lower-priority');
          continue;
        }
        adopt(event, at);
        record(event, 'started');
        // R11：一次 drain 最多 adopt 一个，其余留到下一轮，避免同一帧里连续覆盖刚起的动作。
        break;
      }
    }

    function request(raw) {
      const at = nowOf();
      purge(at);
      const event = normalize(raw, at);
      if (!event) {
        record(null, 'invalid');
        return { accepted: false, reason: 'invalid', bubbleOnly: false };
      }
      if (quiet() && event.priority >= 2) {
        // 契约 §3 与主进程 lib/device-events.js:208 同口径：安静模式下 P2 及以下噪音直接丢弃，连气泡都不发。
        record(event, 'quiet-drop');
        return { accepted: false, reason: 'quiet-drop', bubbleOnly: false };
      }
      if (model.busy && event.priority >= 1) {
        const queued = enqueue(event, at);
        record(event, queued ? 'queued' : 'queue-full');
        return { accepted: queued, reason: queued ? 'queued' : 'queue-full', bubbleOnly: false };
      }
      if (event.priority > gateLevel()) {
        record(event, 'lower-priority');
        return { accepted: false, reason: 'lower-priority', bubbleOnly: false };
      }
      const meta = adopt(event, at);
      record(event, meta.preempted ? 'preempted' : 'started');
      return { accepted: true, reason: meta.preempted ? 'preempted' : 'started', action: event.action, meta: meta, bubbleOnly: false };
    }

    function tick(value) {
      const at = nowOf(value);
      purge(at);

      if (model.oneShot && at >= model.oneShot.until) {
        const finished = model.oneShot;
        model.oneShot = null;
        model.current = finished.restore;
        model.priority = model.ambientLevel;
        model.kind = 'restore';
        model.since = at;
        const meta = { kind: 'restore', priority: AMBIENT_PRIORITY, oneShot: false, transient: false, internal: false, finished: finished.action };
        startAction(finished.restore, false, meta);
        onAction(finished.restore, meta);
        onDone(finished.action);
      }

      if (model.hoverAt >= 0 && !model.hoverFired && at - model.hoverAt >= HOVER_MS) {
        model.hoverFired = true;
        request({ kind: 'hover', action: 'waving', priority: 1, internal: true });
      }

      if (model.pendingClick && at - model.pendingClick >= DOUBLE_MS) {
        model.pendingClick = 0;
        request({ kind: 'click', action: 'waving', priority: 1, internal: true });
      }

      if (model.burstAt && at - model.burstAt >= BURST_SPAN_MS) {
        model.burstAt = 0;
        model.burstCount = 0;
      }

      if (!model.busy && model.queue.length) drain(at);
      return state(at);
    }

    function click(value) {
      const at = nowOf(value);
      if (model.busy) return { action: '', reason: 'busy', played: false };
      if (model.hoverAt >= 0) model.hoverFired = true;
      if (model.burstAt && at - model.burstAt >= BURST_SPAN_MS) {
        model.burstAt = 0;
        model.burstCount = 0;
      }
      if (!model.burstAt) model.burstAt = at;
      model.burstCount += 1;
      if (model.burstCount >= BURST_MAX) {
        const clicks = model.burstCount;
        model.burstCount = 0;
        model.burstAt = 0;
        model.pendingClick = 0;
        const result = request({ kind: 'burst', action: 'failed', priority: 1, internal: true });
        return { action: 'failed', reason: 'burst', played: result.accepted, clicks: clicks };
      }
      if (model.pendingClick && at - model.pendingClick < DOUBLE_MS) {
        model.pendingClick = 0;
        const result = request({ kind: 'double', action: 'jumping', priority: 1, internal: true });
        return { action: 'jumping', reason: 'double', played: result.accepted };
      }
      // 单击必须等双击窗口关闭才能播挥手，否则双击会先闪一下 waving。
      model.pendingClick = at;
      return { action: '', reason: 'pending', played: false };
    }

    function hover(inside, value) {
      const at = nowOf(value);
      const want = inside === true;
      if (model.busy) {
        model.hoverAt = -1;
        model.hoverFired = false;
        return { armed: false, reason: 'busy' };
      }
      if (want) {
        if (at < model.hoverCoolUntil) return { armed: false, reason: 'cooldown' };
        if (model.hoverAt < 0) {
          model.hoverAt = at;
          model.hoverFired = false;
          return { armed: true, reason: 'start' };
        }
        return { armed: false, reason: 'inside' };
      }
      const started = model.hoverAt >= 0;
      model.hoverAt = -1;
      model.hoverFired = false;
      if (started) model.hoverCoolUntil = at + HOVER_COOLDOWN_MS;
      return { armed: false, reason: started ? 'leave' : 'outside' };
    }

    function setBusy(value) {
      const next = value === true;
      if (next === model.busy) return model.busy;
      model.busy = next;
      if (next) {
        model.pendingClick = 0;
        model.hoverAt = -1;
        model.hoverFired = false;
      } else {
        drain(nowOf());
      }
      return model.busy;
    }

    function interrupt(reason) {
      const at = nowOf();
      const kind = typeof reason === 'string' && reason ? reason : 'interrupt';
      model.queue = [];
      model.oneShot = null;
      model.pendingClick = 0;
      model.hoverAt = -1;
      model.hoverFired = false;
      model.burstAt = 0;
      model.burstCount = 0;
      const restore = restoreAction();
      model.current = restore;
      model.priority = model.ambientLevel;
      model.kind = kind;
      model.since = at;
      startAction(restore, false, { kind: kind, priority: AMBIENT_PRIORITY, oneShot: false, transient: false, internal: false });
      record(null, 'interrupt');
      return { current: restore, reason: kind };
    }

    // R6：渲染循环只关心"有没有一次性和排队"，不需要每帧拼整份 state。
    function isLive() {
      return {
        oneShot: model.oneShot ? model.oneShot.action : '',
        queued: model.queue.map(function (item) { return item.action; })
      };
    }

    function state(value) {
      const at = nowOf(value);
      return {
        current: model.current,
        priority: model.priority,
        ambientLevel: model.ambientLevel,
        kind: model.kind,
        since: model.since,
        base: model.base,
        oneShot: model.oneShot ? model.oneShot.action : '',
        oneShotLeft: model.oneShot ? Math.max(0, Math.round(model.oneShot.until - at)) : 0,
        queued: model.queue.map(function (item) { return item.action; }),
        queue: model.queue.map(function (item) {
          return {
            action: item.action,
            kind: item.kind,
            priority: item.priority,
            ttlLeft: Math.max(0, Math.round(item.ttlMs - (at - item.at)))
          };
        }),
        busy: model.busy,
        lastEvent: model.lastEvent ? Object.assign({}, model.lastEvent) : null,
        cooldown: {
          hover: Math.max(0, Math.round(model.hoverCoolUntil - at)),
          burst: model.burstAt ? Math.max(0, Math.round(BURST_SPAN_MS - (at - model.burstAt))) : 0
        },
        hoverAt: model.hoverAt >= 0 ? model.hoverAt : 0,
        burstCount: model.burstCount
      };
    }

    return {
      request: request,
      tick: tick,
      click: click,
      hover: hover,
      interrupt: interrupt,
      isLive: isLive,
      state: state,
      setBusy: setBusy
    };
  }

  return {
    create: create,
    isOneShot: isOneShot,
    clampPriority: clampPriority,
    ONE_SHOT_ACTIONS: ONE_SHOT_ACTIONS,
    RESTORE_ACTIONS: RESTORE_ACTIONS,
    QUEUE_MAX: QUEUE_MAX,
    AMBIENT_PRIORITY: AMBIENT_PRIORITY,
    DOUBLE_MS: DOUBLE_MS,
    BURST_SPAN_MS: BURST_SPAN_MS,
    BURST_MAX: BURST_MAX,
    HOVER_MS: HOVER_MS,
    HOVER_COOLDOWN_MS: HOVER_COOLDOWN_MS
  };
});
