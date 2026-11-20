/**
 * edge-status — a zero-dependency status page and health-check API for Cloudflare Workers.
 *
 * One Worker file gives you:
 *   - a responsive HTML status dashboard (light/dark aware),
 *   - a JSON endpoint at /api/status for machines, badges and scripts,
 *   - a plain-text /health probe that returns 200 or 503,
 *   - latency, HTTP status code and optional keyword checks per target,
 *   - optional uptime history when a KV namespace is bound.
 *
 * Source: https://github.com/hjddl/edge-status
 * License: MIT
 */

const VERSION = '1.0.0';
const REPO_URL = 'https://github.com/hjddl/edge-status';
const USER_AGENT = `edge-status/${VERSION} (+${REPO_URL})`;

const DEFAULTS = {
  title: 'Edge Status',
  slowMs: 800,
  timeoutMs: 8000,
  cacheTtl: 30,
  historySize: 60,
  sampleMs: 300000,
  refreshSeconds: 30,
  maxTargets: 25,
};

const STATUS = { UP: 'up', DEGRADED: 'degraded', DOWN: 'down' };
const OVERALL = { OPERATIONAL: 'operational', DEGRADED: 'degraded', OUTAGE: 'outage' };

const STATUS_LABEL = {
  up: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
};

const OVERALL_LABEL = {
  operational: 'All systems operational',
  degraded: 'Partial degradation',
  outage: 'Major outage',
};

/** Used only when TARGETS is missing so a fresh deploy is never a blank page. */
const DEFAULT_TARGETS = [
  { name: 'Cloudflare 1.1.1.1', url: 'https://1.1.1.1/cdn-cgi/trace' },
  { name: 'GitHub API', url: 'https://api.github.com/zen' },
];

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reads a JSON array of targets from the TARGETS variable.
 * A target looks like:
 *   { "name": "API", "url": "https://api.example.com/health", "expect": [200],
 *     "method": "GET", "keyword": "\"ok\":true", "slowMs": 500, "timeoutMs": 4000 }
 */
function readTargets(env) {
  const raw = env.TARGETS;
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_TARGETS;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : DEFAULT_TARGETS;
  } catch (error) {
    console.warn(`edge-status: TARGETS is not valid JSON (${error.message}); falling back to defaults`);
    return DEFAULT_TARGETS;
  }
}

function normalizeTarget(raw, defaults) {
  if (!raw || typeof raw !== 'object') return null;

  let url;
  try {
    url = new URL(String(raw.url ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const expect = (Array.isArray(raw.expect) ? raw.expect : [raw.expect])
    .map((code) => Number.parseInt(String(code), 10))
    .filter((code) => Number.isInteger(code) && code >= 100 && code < 600);

  const keyword = typeof raw.keyword === 'string' && raw.keyword !== '' ? raw.keyword : null;

  return {
    name: String(raw.name || url.hostname).slice(0, 80),
    url: url.href,
    method: String(raw.method ?? 'GET').toUpperCase() === 'HEAD' ? 'HEAD' : 'GET',
    expect: expect.length > 0 ? expect : null, // null means "any 2xx"
    keyword,
    slowMs: positiveInt(raw.slowMs, defaults.slowMs),
    timeoutMs: positiveInt(raw.timeoutMs, defaults.timeoutMs),
  };
}

function parseConfig(env = {}) {
  const config = {
    title: String(env.PAGE_TITLE || DEFAULTS.title).slice(0, 80),
    slowMs: positiveInt(env.SLOW_MS, DEFAULTS.slowMs),
    timeoutMs: positiveInt(env.TIMEOUT_MS, DEFAULTS.timeoutMs),
    cacheTtl: positiveInt(env.CACHE_TTL, DEFAULTS.cacheTtl),
    historySize: Math.min(positiveInt(env.HISTORY_SIZE, DEFAULTS.historySize), 240),
    sampleMs: positiveInt(env.HISTORY_INTERVAL_MS, DEFAULTS.sampleMs),
    refreshSeconds: positiveInt(env.REFRESH_SECONDS, DEFAULTS.refreshSeconds),
    showLatency: String(env.HIDE_LATENCY ?? '') !== 'true',
  };

  const targets = readTargets(env)
    .slice(0, DEFAULTS.maxTargets)
    .map((raw) => normalizeTarget(raw, config))
    .filter(Boolean);

  config.targets = targets;
  return config;
}

/* -------------------------------------------------------------------------- */
/* Probing a single target                                                    */
/* -------------------------------------------------------------------------- */

function matchesExpectation(code, expect) {
  if (Array.isArray(expect) && expect.length > 0) return expect.includes(code);
  return code >= 200 && code < 300;
}

function describeError(error) {
  if (!error) return 'Request failed';
  const cause = error.cause && (error.cause.message || error.cause.code);
  const message = error.message || String(error);
  if (cause && !message.includes(String(cause))) return `${message} (${cause})`;
  return message;
}

function discardBody(response) {
  // Free the socket when the body is not needed. Never let this break a check.
  try {
    if (response.body) {
      const cancelled = response.body.cancel();
      if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

async function request(target, signal) {
  return fetch(target.url, {
    method: target.method,
    redirect: 'follow',
    signal,
    headers: {
      'user-agent': USER_AGENT,
      accept: '*/*',
      'cache-control': 'no-cache',
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
}

/**
 * Runs one check and always resolves with a result object, never throws.
 */
async function checkTarget(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs);
  const startedAt = Date.now();
  const base = {
    name: target.name,
    url: target.url,
    code: null,
    latencyMs: null,
    error: null,
  };

  try {
    let response = await request(target, controller.signal);

    // Some servers reject HEAD with 405/501; retry once with GET.
    if (target.method === 'HEAD' && (response.status === 405 || response.status === 501)) {
      discardBody(response);
      response = await request({ ...target, method: 'GET' }, controller.signal);
    }

    const latencyMs = Date.now() - startedAt;
    const finishedAt = new Date().toISOString();

    if (!matchesExpectation(response.status, target.expect)) {
      const expected = target.expect ? `expected ${target.expect.join('/')}` : 'expected 2xx';
      discardBody(response);
      return {
        ...base,
        status: STATUS.DOWN,
        code: response.status,
        latencyMs,
        checkedAt: finishedAt,
        error: `HTTP ${response.status} (${expected})`,
      };
    }

    if (target.keyword) {
      const body = await response.text();
      if (!body.includes(target.keyword)) {
        return {
          ...base,
          status: STATUS.DOWN,
          code: response.status,
          latencyMs,
          checkedAt: finishedAt,
          error: `Response body is missing "${target.keyword}"`,
        };
      }
    } else {
      discardBody(response);
    }

    const slow = latencyMs > target.slowMs;
    return {
      ...base,
      status: slow ? STATUS.DEGRADED : STATUS.UP,
      code: response.status,
      latencyMs: Date.now() - startedAt,
      checkedAt: finishedAt,
      error: slow ? `Slower than ${target.slowMs} ms` : null,
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    const latencyMs = Date.now() - startedAt;
    return {
      ...base,
      status: STATUS.DOWN,
      code: null,
      latencyMs,
      checkedAt: new Date().toISOString(),
      error: aborted
        ? `Timed out after ${target.timeoutMs} ms`
        : error && /timed out|timeout/i.test(error.message || '')
          ? `Timed out after ${target.timeoutMs} ms`
          : describeError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Optional uptime history (KV binding EDGE_STATUS_KV)                         */
/* -------------------------------------------------------------------------- */

function historyKey(name) {
  return `hist:${name}`;
}

function isSample(value) {
  return value && typeof value === 'object' && Number.isFinite(value.t) && (value.ok === 0 || value.ok === 1);
}

async function loadHistory(env, config) {
  const history = new Map();
  const kv = env.EDGE_STATUS_KV;
  if (!kv) return history;

  await Promise.all(
    config.targets.map(async (target) => {
      try {
        const stored = await kv.get(historyKey(target.name), 'json');
        if (Array.isArray(stored)) {
          history.set(target.name, stored.filter(isSample).slice(-config.historySize));
        }
      } catch (error) {
        console.warn(`edge-status: cannot read history for ${target.name}: ${error.message}`);
      }
    }),
  );

  return history;
}

async function saveHistory(env, config, results, history) {
  const kv = env.EDGE_STATUS_KV;
  if (!kv) return;

  const now = Date.now();
  await Promise.all(
    results.map(async (result) => {
      const samples = history.get(result.name) || [];
      const last = samples[samples.length - 1];
      if (last && now - last.t < config.sampleMs) return;

      const next = samples
        .concat([{ t: now, ok: result.status === STATUS.DOWN ? 0 : 1, ms: result.latencyMs ?? 0 }])
        .slice(-config.historySize);

      history.set(result.name, next);
      try {
        await kv.put(historyKey(result.name), JSON.stringify(next), { expirationTtl: 60 * 60 * 24 * 7 });
      } catch (error) {
        console.warn(`edge-status: cannot write history for ${result.name}: ${error.message}`);
      }
    }),
  );
}

function uptimeOf(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const up = samples.reduce((sum, sample) => sum + (sample.ok ? 1 : 0), 0);
  return Math.round((up / samples.length) * 1000) / 10;
}

/* -------------------------------------------------------------------------- */
/* Collecting all results                                                     */
/* -------------------------------------------------------------------------- */

function summarize(results) {
  const summary = { total: results.length, up: 0, degraded: 0, down: 0 };
  for (const result of results) summary[result.status] += 1;

  let status = OVERALL.OPERATIONAL;
  if (summary.down > 0) status = OVERALL.OUTAGE;
  else if (summary.degraded > 0) status = OVERALL.DEGRADED;

  return { summary, status };
}

async function collect(config, env, ctx) {
  if (config.targets.length === 0) {
    return {
      status: OVERALL.OUTAGE,
      ok: false,
      title: config.title,
      updatedAt: new Date().toISOString(),
      summary: { total: 0, up: 0, degraded: 0, down: 0 },
      targets: [],
      error: 'No valid targets configured. Set the TARGETS variable to a JSON array of targets.',
    };
  }

  const history = await loadHistory(env, config);
  const results = await Promise.all(config.targets.map((target) => checkTarget(target)));

  if (typeof ctx?.waitUntil === 'function') {
    ctx.waitUntil(saveHistory(env, config, results, history).catch(() => {}));
  } else {
    await saveHistory(env, config, results, history).catch(() => {});
  }

  const { summary, status } = summarize(results);

  return {
    status,
    ok: status === OVERALL.OPERATIONAL,
    title: config.title,
    updatedAt: new Date().toISOString(),
    summary,
    targets: results.map((result) => ({
      ...result,
      uptime: uptimeOf(history.get(result.name)),
      history: (history.get(result.name) || []).map((sample) => ({
        at: new Date(sample.t).toISOString(),
        ok: sample.ok === 1,
        latencyMs: sample.ms,
      })),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Caching: one isolate-level cache plus the colo cache                       */
/* -------------------------------------------------------------------------- */

const memoryCache = { payload: null, expiresAt: 0, computedAt: 0 };
const MIN_REFRESH_MS = 2000;

/** Clears the in-isolate cache. Used by the test suite. */
function resetCache() {
  memoryCache.payload = null;
  memoryCache.expiresAt = 0;
  memoryCache.computedAt = 0;
}

function edgeCache() {
  try {
    return typeof caches !== 'undefined' && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

function cacheKey(request) {
  return new Request(new URL('/__edge-status/cache', request.url), { method: 'GET' });
}

async function getStatus(request, env, ctx) {
  const config = parseConfig(env);
  const url = new URL(request.url);
  const forceFresh = url.searchParams.get('fresh') === '1';
  const now = Date.now();

  if (memoryCache.payload && memoryCache.expiresAt > now) {
    return { payload: { ...memoryCache.payload, cached: true }, config };
  }
  if (forceFresh && memoryCache.payload && now - memoryCache.computedAt < MIN_REFRESH_MS) {
    return { payload: { ...memoryCache.payload, cached: true }, config };
  }

  const cache = edgeCache();
  if (cache && !forceFresh) {
    try {
      const hit = await cache.match(cacheKey(request));
      if (hit) {
        const payload = await hit.json();
        memoryCache.payload = payload;
        memoryCache.computedAt = now;
        memoryCache.expiresAt = now + config.cacheTtl * 1000;
        return { payload: { ...payload, cached: true }, config };
      }
    } catch (error) {
      console.warn(`edge-status: cache read failed: ${error.message}`);
    }
  }

  const payload = await collect(config, env, ctx);
  memoryCache.payload = payload;
  memoryCache.computedAt = Date.now();
  memoryCache.expiresAt = memoryCache.computedAt + config.cacheTtl * 1000;

  if (cache) {
    const store = async () => {
      try {
        await cache.put(
          cacheKey(request),
          new Response(JSON.stringify(payload), {
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': `public, max-age=${config.cacheTtl}`,
            },
          }),
        );
      } catch (error) {
        console.warn(`edge-status: cache write failed: ${error.message}`);
      }
    };
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(store());
    else await store();
  }

  return { payload: { ...payload, cached: false }, config };
}

/* -------------------------------------------------------------------------- */
/* HTTP responses                                                             */
/* -------------------------------------------------------------------------- */

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

function jsonResponse(body, { status = 200, maxAge = 0, pretty = false } = {}) {
  return new Response(pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'cache-control': maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store',
    },
  });
}

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/* -------------------------------------------------------------------------- */
/* HTML dashboard                                                             */
/* -------------------------------------------------------------------------- */

const CSS = `
:root {
  --bg: #f5f7fa;
  --card: #ffffff;
  --text: #0f172a;
  --muted: #64748b;
  --line: #e2e8f0;
  --up: #16a34a;
  --up-soft: #dcfce7;
  --degraded: #d97706;
  --degraded-soft: #fef3c7;
  --down: #dc2626;
  --down-soft: #fee2e2;
  --accent: #2563eb;
  --shadow: 0 1px 2px rgba(15, 23, 42, .06), 0 8px 24px rgba(15, 23, 42, .04);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b1120;
    --card: #111a2e;
    --text: #e6edf7;
    --muted: #8b9bb4;
    --line: #1e293b;
    --up: #4ade80;
    --up-soft: rgba(74, 222, 128, .14);
    --degraded: #fbbf24;
    --degraded-soft: rgba(251, 191, 36, .14);
    --down: #f87171;
    --down-soft: rgba(248, 113, 113, .14);
    --accent: #60a5fa;
    --shadow: 0 1px 2px rgba(0, 0, 0, .3), 0 8px 24px rgba(0, 0, 0, .25);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 32px 20px 56px;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { width: 100%; max-width: 960px; margin: 0 auto; }
header.top {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px;
  margin-bottom: 22px;
}
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.logo {
  width: 30px; height: 30px; border-radius: 9px; flex: none;
  background: linear-gradient(135deg, var(--accent), #22d3ee);
  display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 15px;
}
h1 { font-size: 19px; line-height: 1.2; margin: 0; font-weight: 650; letter-spacing: -.01em; }
.top-meta { margin-left: auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.muted { color: var(--muted); font-size: 13px; }
.pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 11px; border-radius: 999px; font-size: 12.5px; font-weight: 600;
  border: 1px solid transparent; white-space: nowrap;
}
.pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.pill--up { color: var(--up); background: var(--up-soft); border-color: color-mix(in srgb, var(--up) 22%, transparent); }
.pill--degraded { color: var(--degraded); background: var(--degraded-soft); border-color: color-mix(in srgb, var(--degraded) 22%, transparent); }
.pill--down { color: var(--down); background: var(--down-soft); border-color: color-mix(in srgb, var(--down) 22%, transparent); }
.overall {
  background: var(--card); border: 1px solid var(--line); border-radius: 16px;
  padding: 20px 22px; margin-bottom: 20px; box-shadow: var(--shadow);
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px;
}
.overall h2 { margin: 0; font-size: 17px; font-weight: 650; }
.overall .counts { margin-left: auto; display: flex; gap: 16px; }
.count { text-align: center; min-width: 52px; }
.count b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
.grid {
  display: grid; gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(272px, 1fr));
}
.card {
  background: var(--card); border: 1px solid var(--line); border-radius: 16px;
  padding: 18px 18px 16px; box-shadow: var(--shadow); min-width: 0;
}
.card-head { display: flex; align-items: flex-start; gap: 10px; }
.card-head h3 {
  margin: 0; font-size: 15px; font-weight: 650; line-height: 1.35;
  overflow-wrap: anywhere; flex: 1 1 auto;
}
.card-head .pill { flex: none; font-size: 11.5px; padding: 3px 9px; }
.url {
  margin: 7px 0 14px; font-size: 12px; color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  overflow-wrap: anywhere; word-break: break-all;
}
.metrics { display: flex; gap: 18px; flex-wrap: wrap; }
.metric { min-width: 62px; }
.metric span { display: block; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.metric strong { font-size: 17px; font-weight: 650; font-variant-numeric: tabular-nums; }
.bars { display: flex; align-items: flex-end; gap: 2px; height: 26px; margin-top: 14px; }
.bars i { flex: 1 1 auto; height: 100%; border-radius: 2px; background: var(--line); display: block; }
.bars i.ok { background: var(--up); opacity: .75; }
.bars i.bad { background: var(--down); opacity: .8; }
.bars.empty { border-radius: 6px; background: repeating-linear-gradient(90deg, var(--line) 0 6px, transparent 6px 10px); height: 6px; align-items: center; }
.note { margin: 10px 0 0; font-size: 12px; color: var(--muted); min-height: 18px; overflow-wrap: anywhere; }
.note.warn { color: var(--down); }
footer {
  margin-top: 30px; padding-top: 18px; border-top: 1px solid var(--line);
  display: flex; flex-wrap: wrap; gap: 8px 14px; font-size: 12.5px; color: var(--muted);
}
footer a { color: var(--accent); text-decoration: none; }
footer a:hover { text-decoration: underline; }
footer .spacer { margin-left: auto; }
.err {
  background: var(--card); border: 1px solid var(--down); border-radius: 16px;
  padding: 18px 20px; color: var(--text);
}
.err code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
@media (max-width: 520px) {
  body { padding: 22px 14px 40px; }
  .overall .counts { margin-left: 0; width: 100%; justify-content: space-between; }
}
`;

// Client-side update, kept dependency free and backtick free.
const CLIENT_JS = `
(function () {
  var body = document.body;
  var every = parseInt(body.getAttribute('data-refresh'), 10) || 30;
  var label = document.getElementById('countdown');
  var left = every;

  function localTime(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return iso;
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function syncTimes() {
    var nodes = document.querySelectorAll('[data-iso]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = localTime(nodes[i].getAttribute('data-iso'));
    }
  }

  function setField(card, field, value) {
    var node = card.querySelector('[data-field="' + field + '"]');
    if (node) node.textContent = value;
  }

  function paintBars(card, samples) {
    var holder = card.querySelector('[data-field="bars"]');
    if (!holder) return;
    if (!samples || !samples.length) { holder.className = 'bars empty'; holder.innerHTML = ''; return; }
    holder.className = 'bars';
    var html = '';
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      html += '<i class="' + (s.ok ? 'ok' : 'bad') + '" title="' + s.at + ' · ' + (s.latencyMs || 0) + ' ms"></i>';
    }
    holder.innerHTML = html;
  }

  function paint(data) {
    var overall = document.getElementById('overall-status');
    if (overall) {
      var map = { operational: 'up', degraded: 'degraded', outage: 'down' };
      var names = { operational: 'All systems operational', degraded: 'Partial degradation', outage: 'Major outage' };
      overall.textContent = names[data.status] || data.status;
      overall.className = 'pill pill--' + (map[data.status] || 'down');
    }
    var updatedNode = document.getElementById('updated');
    if (updatedNode) {
      updatedNode.setAttribute('data-iso', data.updatedAt);
      updatedNode.textContent = localTime(data.updatedAt);
    }
    var counts = { up: data.summary.up, degraded: data.summary.degraded, down: data.summary.down };
    for (var key in counts) {
      var node = document.querySelector('[data-count="' + key + '"]');
      if (node) node.textContent = counts[key];
    }
    var cards = document.querySelectorAll('[data-index]');
    for (var i = 0; i < cards.length; i++) {
      var target = data.targets[i];
      if (!target) continue;
      var card = cards[i];
      var pill = card.querySelector('[data-field="status"]');
      if (pill) {
        var labels = { up: 'Operational', degraded: 'Degraded', down: 'Down' };
        pill.textContent = labels[target.status] || target.status;
        pill.className = 'pill pill--' + target.status;
      }
      setField(card, 'latency', target.latencyMs === null ? '—' : target.latencyMs + ' ms');
      setField(card, 'code', target.code === null ? '—' : String(target.code));
      setField(card, 'uptime', target.uptime === null ? '—' : target.uptime.toFixed(1) + '%');
      var note = card.querySelector('[data-field="note"]');
      if (note) {
        note.textContent = target.error || ('Checked ' + localTime(target.checkedAt));
        note.className = 'note' + (target.error ? ' warn' : '');
      }
      paintBars(card, target.history);
    }
  }

  function tick() {
    if (document.hidden) return;
    left -= 1;
    if (label) label.textContent = left + 's';
    if (left > 0) return;
    left = every;
    if (label) label.textContent = left + 's';
    fetch('/api/status', { cache: 'no-store' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) { if (data) paint(data); })
      .catch(function () { /* keep the page as it is and try again next tick */ });
  }

  syncTimes();
  if (label) label.textContent = left + 's';
  setInterval(tick, 1000);
})();
`;

function renderCard(target, index, config) {
  const uptime = target.uptime === null ? '—' : `${target.uptime.toFixed(1)}%`;
  const latency = target.latencyMs === null ? '—' : `${target.latencyMs} ms`;
  const code = target.code === null ? '—' : String(target.code);
  const bars = (target.history || [])
    .map(
      (sample) =>
        `<i class="${sample.ok ? 'ok' : 'bad'}" title="${esc(sample.at)} · ${esc(sample.latencyMs)} ms"></i>`,
    )
    .join('');
  const note = esc(target.error || `Checked ${target.checkedAt}`);
  const history = target.history && target.history.length > 0;

  return `<article class="card" data-index="${index}">
  <div class="card-head">
    <h3>${esc(target.name)}</h3>
    <span class="pill pill--${esc(target.status)}" data-field="status">${esc(STATUS_LABEL[target.status] || target.status)}</span>
  </div>
  <p class="url">${esc(target.url)}</p>
  <div class="metrics">
    ${
      config.showLatency
        ? `<div class="metric"><span>Latency</span><strong data-field="latency">${esc(latency)}</strong></div>`
        : ''
    }
    <div class="metric"><span>Code</span><strong data-field="code">${esc(code)}</strong></div>
    <div class="metric"><span>Uptime</span><strong data-field="uptime">${esc(uptime)}</strong></div>
  </div>
  <div class="${history ? 'bars' : 'bars empty'}" data-field="bars">${history ? bars : ''}</div>
  <p class="note${target.error ? ' warn' : ''}" data-field="note">${note}</p>
</article>`;
}

function renderPage(payload, config) {
  const title = esc(payload.title || config.title);
  const cards =
    payload.targets.length > 0
      ? payload.targets.map((target, index) => renderCard(target, index, config)).join('\n')
      : `<div class="err"><h2>No targets configured</h2>
        <p>Set the <code>TARGETS</code> variable in <code>wrangler.toml</code> to a JSON array, for example:</p>
        <p><code>[{"name":"My API","url":"https://api.example.com/health"}]</code></p>
        <p class="muted">${esc(payload.error || '')}</p></div>`;

  const updated = payload.updatedAt;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body data-refresh="${config.refreshSeconds}">
<div class="wrap">
  <header class="top">
    <div class="brand">
      <div class="logo" aria-hidden="true">e</div>
      <h1>${title}</h1>
    </div>
    <div class="top-meta">
      <span class="muted">Updated <span id="updated" data-iso="${esc(updated)}">${esc(updated)}</span></span>
      <span class="muted" aria-live="polite"><span id="countdown">${config.refreshSeconds}s</span></span>
    </div>
  </header>

  <section class="overall">
    <h2>Live status</h2>
    <span id="overall-status" class="pill pill--${
      payload.status === OVERALL.OPERATIONAL ? 'up' : payload.status === OVERALL.DEGRADED ? 'degraded' : 'down'
    }">${esc(OVERALL_LABEL[payload.status] || payload.status)}</span>
    <div class="counts">
      <div class="count"><b data-count="up">${payload.summary.up}</b><span class="muted">Up</span></div>
      <div class="count"><b data-count="degraded">${payload.summary.degraded}</b><span class="muted">Degraded</span></div>
      <div class="count"><b data-count="down">${payload.summary.down}</b><span class="muted">Down</span></div>
    </div>
  </section>

  <main class="grid">
${cards}
  </main>

  <footer>
    <span>edge-status ${VERSION}</span>
    <a href="/api/status">JSON API</a>
    <a href="/health">Health probe</a>
    <a class="spacer" href="${REPO_URL}">Powered by edge-status</a>
  </footer>
</div>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

async function handlePage(request, env, ctx) {
  const { payload, config } = await getStatus(request, env, ctx);
  const html = renderPage(payload, config);
  return new Response(request.method === 'HEAD' ? null : html, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, max-age=${Math.min(config.cacheTtl, 60)}`,
      'content-security-policy': [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "script-src 'unsafe-inline'",
        "img-src data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    },
  });
}

async function handleApi(request, env, ctx) {
  const { payload, config } = await getStatus(request, env, ctx);
  const url = new URL(request.url);
  const pretty = url.searchParams.get('pretty') === '1';
  const fresh = url.searchParams.get('fresh') === '1';
  const body = jsonResponse({ ...payload, version: VERSION }, {
    status: 200,
    maxAge: fresh ? 0 : config.cacheTtl,
    pretty,
  });
  return request.method === 'HEAD' ? new Response(null, { status: 200, headers: body.headers }) : body;
}

async function handleHealth(request, env, ctx) {
  const { payload } = await getStatus(request, env, ctx);
  const healthy = payload.status === OVERALL.OPERATIONAL;
  return textResponse(healthy ? 'OK\n' : `${payload.status.toUpperCase()}\n`, healthy ? 200 : 503);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, HEAD, OPTIONS',
          'access-control-max-age': '86400',
        },
      });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return textResponse('Method Not Allowed\n', 405);
    }

    switch (url.pathname) {
      case '/':
      case '/index.html':
        return handlePage(request, env, ctx);
      case '/api/status':
      case '/api/status.json':
        return handleApi(request, env, ctx);
      case '/health':
      case '/healthz':
        return handleHealth(request, env, ctx);
      case '/robots.txt':
        return textResponse('User-agent: *\nDisallow: /\n');
      case '/favicon.ico':
        return new Response(null, { status: 204, headers: SECURITY_HEADERS });
      default:
        return jsonResponse({ error: 'Not Found', routes: ['/', '/api/status', '/health'] }, { status: 404 });
    }
  },
};

// Named exports exist so the module can be unit tested outside the Workers runtime.
export { parseConfig, checkTarget, collect, renderPage, summarize, uptimeOf, resetCache };
