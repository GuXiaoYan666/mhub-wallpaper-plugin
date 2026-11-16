'use strict';
// 天气：双数据源 + 3 日预报，按 %APPDATA%\MCHOSEHUB\sysdeck\weather.json 缓存。
// 数据源链：wttr.in（j1，主）→ Open-Meteo（备，经 ipwho.is 定位）。
// 任一源成功即用；全部失败回落缓存并标记 stale。刷新周期默认 30 分钟，绝不抛错。

const fs = require('fs');
const https = require('https');
const path = require('path');
const P = require('./paths.js');

const DEFAULT_MIN = 30;
const FETCH_TIMEOUT_MS = 9000;

// WMO 天气码 → 中文描述 + 符号（wttr.in 与 Open-Meteo 共用同一套 WMO 码）
const WMO = {
  '0': ['晴', '☀️'], '1': ['晴间多云', '🌤️'], '2': ['多云', '⛅'], '3': ['阴', '☁️'],
  '45': ['雾', '🌫️'], '48': ['冻雾', '🌫️'],
  '51': ['毛毛雨', '🌦️'], '53': ['毛毛雨', '🌦️'], '55': ['毛毛雨', '🌦️'],
  '56': ['冻毛毛雨', '🌧️'], '57': ['冻毛毛雨', '🌧️'],
  '61': ['小雨', '🌧️'], '63': ['中雨', '🌧️'], '65': ['大雨', '🌧️'],
  '66': ['冻雨', '🌧️'], '67': ['冻雨', '🌧️'],
  '71': ['小雪', '🌨️'], '73': ['中雪', '❄️'], '75': ['大雪', '❄️'], '77': ['雪粒', '🌨️'],
  '80': ['小阵雨', '🌦️'], '81': ['阵雨', '🌦️'], '82': ['强阵雨', '🌧️'],
  '85': ['小阵雪', '🌨️'], '86': ['阵雪', '🌨️'],
  '95': ['雷阵雨', '⛈️'], '96': ['雷伴冰雹', '⛈️'], '99': ['雷伴冰雹', '⛈️']
};
// wttr.in 专用码
const WMO_WTTR = {
  '113': ['晴', '☀️'], '116': ['多云', '⛅'], '119': ['阴', '☁️'], '122': ['阴天', '☁️'],
  '143': ['雾', '🌫️'], '248': ['雾', '🌫️'], '260': ['冻雾', '🌫️'], '149': ['烟霾', '🌫️'],
  '176': ['小阵雨', '🌦️'], '263': ['毛毛雨', '🌦️'], '266': ['细雨', '🌦️'], '281': ['冻毛毛雨', '🌧️'],
  '284': ['冻毛毛雨', '🌧️'], '293': ['小阵雨', '🌦️'], '296': ['小雨', '🌧️'], '299': ['阵雨', '🌦️'],
  '302': ['中雨', '🌧️'], '305': ['中雨', '🌧️'], '308': ['大雨', '🌧️'], '311': ['冻雨', '🌧️'],
  '314': ['冻雨', '🌧️'], '317': ['雨夹雪', '🌨️'], '320': ['雨夹雪', '🌨️'], '323': ['小雪', '🌨️'],
  '326': ['小雪', '🌨️'], '329': ['中雪', '❄️'], '332': ['中雪', '❄️'], '335': ['大雪', '❄️'],
  '338': ['大雪', '❄️'], '350': ['冰雹', '🌧️'], '353': ['阵雨', '🌦️'], '356': ['强阵雨', '🌧️'],
  '359': ['暴雨', '🌧️'], '362': ['雨夹雪', '🌨️'], '365': ['雨夹雪', '🌨️'], '368': ['小雪', '🌨️'],
  '371': ['中雪', '❄️'], '374': ['冻毛毛雨', '🌧️'], '377': ['冻毛毛雨', '🌧️'], '386': ['雷阵雨', '⛈️'],
  '389': ['雷雨大风', '⛈️'], '392': ['雷伴雪', '⛈️'], '395': ['强雷雪', '⛈️'],
  '200': ['雷阵雨', '⛈️'], '227': ['吹雪', '🌨️'], '230': ['暴风雪', '❄️']
};

function describeWttr(code, fallbackText) {
  const key = String(code || '').trim();
  if (WMO_WTTR[key]) return WMO_WTTR[key];
  if (WMO[key]) return WMO[key];
  return describeByText(fallbackText);
}

function describeByText(fallbackText) {
  const t = String(fallbackText || '');
  if (/thunder/i.test(t)) return ['雷阵雨', '⛈️'];
  if (/(heavy|moderate) (rain|shower)/i.test(t)) return ['大雨', '🌧️'];
  if (/(light|patchy) (rain|drizzle|shower)/i.test(t)) return ['小雨', '🌦️'];
  if (/snow/i.test(t)) return ['雪', '❄️'];
  if (/fog|mist/i.test(t)) return ['雾', '🌫️'];
  if (/haze|smoke|dust/i.test(t)) return ['霾', '🌫️'];
  if (/overcast/i.test(t)) return ['阴', '☁️'];
  if (/cloud/i.test(t)) return ['多云', '⛅'];
  if (/clear|sunny/i.test(t)) return ['晴', '☀️'];
  return [t || '未知', '🌡️'];
}

function describeOpenMeteo(code) {
  const key = String(code === null || code === undefined ? '' : code).trim();
  return WMO[key] || ['未知', '🌡️'];
}

function createWeather(options) {
  const logger = options && options.logger;
  const state = { data: null, fetching: false, lastTriedAt: 0, geo: null };

  function readCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(P.WEATHER_CACHE_FILE, 'utf8'));
      if (raw && typeof raw.tempC === 'number' && raw.at) {
        if (!state.data || (state.data.at || 0) < raw.at) state.data = raw;
      }
    } catch (e) { /* 没有缓存 */ }
  }

  function fetchJson(url, cb) {
    const req = https.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      headers: { 'User-Agent': 'SenseDeck/1.3 (M HUB plugin)', 'Accept': 'application/json,text/plain,*/*' }
    }, function (res) {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', function (d) { out += d; if (out.length > 512 * 1024) { req.destroy(); cb(new Error('payload too large')); } });
      res.on('end', function () {
        if (res.statusCode !== 200) { cb(new Error('HTTP ' + res.statusCode)); return; }
        try { cb(null, JSON.parse(out)); } catch (e) { cb(new Error('bad json')); }
      });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', function (e) { cb(e); });
  }

  function normalize(data) {
    data.at = Date.now();
    data.stale = false;
    if (!Array.isArray(data.forecast)) data.forecast = [];
    data.forecast = data.forecast.slice(0, 3).map(function (f) {
      return {
        date: String(f.date || '').slice(0, 10),
        minC: typeof f.minC === 'number' ? Math.round(f.minC) : null,
        maxC: typeof f.maxC === 'number' ? Math.round(f.maxC) : null,
        text: String(f.text || ''),
        icon: String(f.icon || '🌡️')
      };
    });
    return data;
  }

  // ---------- 源 1：wttr.in ----------

  function fetchWttr(loc, cb) {
    fetchJson('https://wttr.in/' + encodeURIComponent(loc || '') + '?format=j1&m', function (err, json) {
      if (err || !json || !json.current_condition || !json.current_condition[0]) { cb(err || new Error('wttr empty')); return; }
      try {
        const cur = json.current_condition[0];
        const area = json.nearest_area && json.nearest_area[0];
        const city = area && area.areaName && area.areaName[0] ? String(area.areaName[0].value) : '';
        const desc0 = cur.weatherDesc && cur.weatherDesc[0] ? String(cur.weatherDesc[0].value) : '';
        const pair = describeWttr(cur.weatherCode, desc0);
        const forecast = [];
        if (Array.isArray(json.weather)) {
          for (let i = 0; i < json.weather.length && i < 3; i++) {
            const d = json.weather[i];
            // 取中午时段的天气码作为当天代表
            let code = '', text = '';
            if (Array.isArray(d.hourly)) {
              const mid = d.hourly.reduce(function (a, b) {
                return Math.abs(Number(a.time || 0) - 1200) < Math.abs(Number(b.time || 0) - 1200) ? a : b;
              }, d.hourly[0] || {});
              code = mid.weatherCode;
              text = mid.weatherDesc && mid.weatherDesc[0] ? String(mid.weatherDesc[0].value) : '';
            }
            const p = describeWttr(code, text);
            forecast.push({ date: d.date, minC: Number(d.mintempC), maxC: Number(d.maxtempC), text: p[0], icon: p[1] });
          }
        }
        cb(null, normalize({
          tempC: Math.round(Number(cur.temp_C)),
          feelsC: Math.round(Number(cur.FeelsLikeC || cur.temp_C)),
          humidity: Math.round(Number(cur.humidity)) || null,
          windKph: Number(cur.windspeedKmph) || 0,
          windDeg: Number(cur.winddirDegree) || 0,
          code: String(cur.weatherCode || ''),
          text: pair[0],
          icon: pair[1],
          city: city,
          forecast: forecast
        }));
      } catch (e) { cb(e); }
    });
  }

  // ---------- 源 2：ipwho.is 定位 + Open-Meteo ----------

  function fetchGeo(cb) {
    if (state.geo) { cb(null, state.geo); return; }
    // IP 定位给的是拼音/英文地名，反查一次中文地名（失败就用原值）。
    function reverseCn(lat, lon, fallback, done) {
      fetchJson('https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + lat +
        '&longitude=' + lon + '&localityLanguage=zh', function (err, json) {
        const cn = (!err && json) ? String(json.city || json.locality || '') : '';
        done(cn || String(fallback || ''));
      });
    }
    function done(lat, lon, city) {
      reverseCn(lat, lon, city, function (name) {
        state.geo = { lat: lat, lon: lon, city: name };
        cb(null, state.geo);
      });
    }
    // 主源 ipwho.is，失败再试 ipapi.co，降低单一服务不可用导致的定位失败。
    fetchJson('https://ipwho.is/', function (err, json) {
      if (!err && json && json.success !== false &&
        typeof json.latitude === 'number' && typeof json.longitude === 'number') {
        done(json.latitude, json.longitude, json.city);
        return;
      }
      fetchJson('https://ipapi.co/json/', function (err2, j2) {
        if (!err2 && j2 && typeof j2.latitude === 'number' && typeof j2.longitude === 'number') {
          done(j2.latitude, j2.longitude, j2.city);
          return;
        }
        cb(new Error('geo unavailable'));
      });
    });
  }

  function fetchGeoList(name, cb) {
    const url = 'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(name) +
      '&count=10&language=zh&format=json';
    fetchJson(url, function (err, json) {
      cb(null, (json && json.results) || []);
    });
  }

  function fetchGeocode(name, cb) {
    const base = String(name || '').trim();
    const variants = [base];
    // “长沙”在库里只匹配到同名小镇，“长沙市”才是省会长沙，两种都查一遍。
    if (base && !/[市县区]$/.test(base)) variants.push(base + '市');
    let best = null;
    let idx = 0;
    function step() {
      if (idx >= variants.length) {
        if (!best) { cb(new Error('geocode miss')); return; }
        cb(null, { lat: best.latitude, lon: best.longitude, city: String(best.name || base) });
        return;
      }
      fetchGeoList(variants[idx++], function (_err, list) {
        for (let i = 0; i < list.length; i++) {
          if (!best || (list[i].population || 0) > (best.population || 0)) best = list[i];
        }
        step();
      });
    }
    step();
  }

  function fetchOpenMeteo(geo, cb) {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + geo.lat + '&longitude=' + geo.lon +
      '&current_temperature=true&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=3&timezone=auto';
    fetchJson(url, function (err, json) {
      if (err || !json || !json.current) { cb(err || new Error('open-meteo empty')); return; }
      try {
        const cur = json.current;
        const pair = describeOpenMeteo(cur.weather_code);
        const forecast = [];
        if (json.daily && Array.isArray(json.daily.time)) {
          for (let i = 0; i < json.daily.time.length && i < 3; i++) {
            const p = describeOpenMeteo(json.daily.weather_code[i]);
            forecast.push({
              date: json.daily.time[i],
              minC: json.daily.temperature_2m_min[i],
              maxC: json.daily.temperature_2m_max[i],
              text: p[0], icon: p[1]
            });
          }
        }
        cb(null, normalize({
          tempC: Math.round(Number(cur.temperature_2m)),
          feelsC: Math.round(Number(cur.apparent_temperature)),
          humidity: cur.relative_humidity_2m != null ? Math.round(Number(cur.relative_humidity_2m)) : null,
          windKph: cur.wind_speed_10m != null ? Number(cur.wind_speed_10m) : 0,
          windDeg: cur.wind_direction_10m != null ? Number(cur.wind_direction_10m) : 0,
          code: String(cur.weather_code == null ? '' : cur.weather_code),
          text: pair[0],
          icon: pair[1],
          city: geo.city || '',
          forecast: forecast
        }));
      } catch (e) { cb(e); }
    });
  }

  function tryNext(providers, idx, cb) {
    if (idx >= providers.length) { cb(new Error('all providers failed')); return; }
    providers[idx](function (err, data) {
      if (err) {
        if (logger) logger.debug('provider ' + idx + ' failed: ' + (err && err.message));
        tryNext(providers, idx + 1, cb);
        return;
      }
      cb(null, data);
    });
  }

  function save(data) {
    state.data = data;
    try { fs.mkdirSync(path.dirname(P.WEATHER_CACHE_FILE), { recursive: true }); } catch (e) { /* ignore */ }
    try { fs.writeFileSync(P.WEATHER_CACHE_FILE, JSON.stringify(data), 'utf8'); } catch (e) { /* ignore */ }
    if (logger) logger.info('weather updated: ' + data.city + ' ' + data.tempC + 'C ' + data.text + ' forecast=' + data.forecast.length);
  }

  function refresh(force, overrides, done) {
    const now = Date.now();
    const min = (options && options.refreshMin) || DEFAULT_MIN;
    if (!force && state.data && now - state.data.at < min * 60 * 1000) return;
    if (!force && state.fetching) return;
    if (!force && now - state.lastTriedAt < 120000) return; // 失败后至少等 2 分钟
    state.lastTriedAt = now;
    state.fetching = true;

    // overrides.location 由调用方按当前配置传入，改城市后能立即生效。
    const loc = (overrides && typeof overrides.location === 'string')
      ? overrides.location
      : ((options && options.location) || '');
    const chain = [
      function (cb) {
        // 指定城市：直接查城市；未指定：先用 IP 定位拿坐标，再按坐标查，避免 wttr 自己猜位置。
        if (loc) { fetchWttr(loc, cb); return; }
        fetchGeo(function (gerr, geo) {
          if (gerr || !geo) { fetchWttr('', cb); return; }
          fetchWttr(geo.lat.toFixed(3) + ',' + geo.lon.toFixed(3), function (werr, data) {
            if (!werr && data) {
              // wttr 的地名常是拼音（Changshashih），优先用中文反查结果。
              if (!data.city || (!/[\u4e00-\u9fa5]/.test(data.city) && geo.city)) data.city = geo.city;
              cb(null, data);
              return;
            }
            cb(werr || new Error('wttr coords failed'));
          });
        });
      },
      function (cb) {
        // 用户指定了城市就按城市地理编码；没指定才退回 IP 粗定位。
        if (loc) {
          fetchGeocode(loc, function (gerr, geo) {
            if (gerr) { cb(gerr); return; }
            fetchOpenMeteo(geo, cb);
          });
          return;
        }
        fetchGeo(function (gerr, geo) {
          if (gerr) { cb(gerr); return; }
          fetchOpenMeteo(geo, cb);
        });
      }
    ];
    tryNext(chain, 0, function (err, data) {
      state.fetching = false;
      if (err || !data) {
        if (logger) logger.debug('weather all providers failed: ' + (err && err.message || 'empty'));
        if (state.data) state.data.stale = true;
        if (typeof done === 'function') done(null);
        return;
      }
      save(data);
      if (typeof done === 'function') done(state.data || null);
    });
  }

  function snapshot() {
    if (!state.data) readCache();
    return state.data ? Object.assign({}, state.data) : null;
  }

  readCache();

  return { refresh: refresh, snapshot: snapshot };
}

module.exports = { createWeather: createWeather, describeWttr: describeWttr, describeOpenMeteo: describeOpenMeteo };
