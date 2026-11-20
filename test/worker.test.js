/**
 * Unit tests for edge-status. They run on plain Node (>= 18) by stubbing fetch,
 * so no Workers runtime, no network and no dependencies are needed:
 *
 *   node --test test/
 */

import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import worker, { checkTarget, parseConfig, renderPage, resetCache, summarize, uptimeOf } from '../src/index.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetCache();
});

function respond(status, body = 'ok', headers = {}) {
  return new Response(body, { status, headers });
}

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return calls;
}

function ctx() {
  const pending = [];
  return { pending, waitUntil: (promise) => pending.push(promise) };
}

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

test('parseConfig fills defaults', () => {
  const config = parseConfig({});
  assert.equal(config.title, 'Edge Status');
  assert.equal(config.cacheTtl, 30);
  assert.equal(config.showLatency, true);
  assert.equal(config.targets.length, 2, 'falls back to the demo targets');
  assert.equal(config.targets[0].expect, null, 'no expect means any 2xx');
});

test('parseConfig reads targets and per-target overrides', () => {
  const config = parseConfig({
    TARGETS: JSON.stringify([
      { name: 'API', url: 'https://api.example.com/health', expect: [200, 204], keyword: '"ok"', slowMs: 250, timeoutMs: 1500 },
      { url: 'https://example.com' },
    ]),
    SLOW_MS: '1000',
    CACHE_TTL: '90',
  });

  assert.equal(config.cacheTtl, 90);
  assert.deepEqual(config.targets[0].expect, [200, 204]);
  assert.equal(config.targets[0].keyword, '"ok"');
  assert.equal(config.targets[0].slowMs, 250);
  assert.equal(config.targets[0].timeoutMs, 1500);
  assert.equal(config.targets[1].name, 'example.com', 'name falls back to the hostname');
  assert.equal(config.targets[1].slowMs, 1000, 'inherits the global slow threshold');
});

test('parseConfig drops unusable targets and survives broken JSON', () => {
  const config = parseConfig({
    TARGETS: JSON.stringify([
      { name: 'bad', url: 'ftp://example.com/file' },
      { name: 'also bad', url: 'not a url' },
      { name: 'good', url: 'https://example.com' },
    ]),
  });
  assert.equal(config.targets.length, 1);
  assert.equal(config.targets[0].name, 'good');

  const fallback = parseConfig({ TARGETS: '[]' });
  assert.equal(fallback.targets.length, 0);

  const broken = parseConfig({ TARGETS: '{oops' });
  assert.equal(broken.targets.length, 2, 'invalid JSON falls back to the demo targets');
});

test('HIDE_LATENCY is read as a boolean string', () => {
  assert.equal(parseConfig({ HIDE_LATENCY: 'true' }).showLatency, false);
  assert.equal(parseConfig({ HIDE_LATENCY: 'false' }).showLatency, true);
});

/* -------------------------------------------------------------------------- */
/* Probing                                                                    */
/* -------------------------------------------------------------------------- */

test('a 2xx response is up and reports latency', async () => {
  stubFetch(() => respond(200));
  const result = await checkTarget({ name: 'a', url: 'https://a.test/', method: 'GET', expect: null, keyword: null, slowMs: 5000, timeoutMs: 1000 });

  assert.equal(result.status, 'up');
  assert.equal(result.code, 200);
  assert.equal(typeof result.latencyMs, 'number');
  assert.equal(result.error, null);
});

test('an unexpected status code is down', async () => {
  stubFetch(() => respond(500));
  const result = await checkTarget({ name: 'a', url: 'https://a.test/', method: 'GET', expect: [200], keyword: null, slowMs: 5000, timeoutMs: 1000 });

  assert.equal(result.status, 'down');
  assert.equal(result.code, 500);
  assert.match(result.error, /HTTP 500/);
});

test('a custom accept list is honoured', async () => {
  stubFetch(() => respond(204, null));
  const accepted = await checkTarget({ name: 'a', url: 'https://a.test/', method: 'GET', expect: [200, 204], keyword: null, slowMs: 5000, timeoutMs: 1000 });
  assert.equal(accepted.status, 'up');

  stubFetch(() => respond(301));
  const rejected = await checkTarget({ name: 'a', url: 'https://a.test/', method: 'GET', expect: [200], keyword: null, slowMs: 5000, timeoutMs: 1000 });
  assert.equal(rejected.status, 'down');
});

test('slow but successful responses are degraded', async () => {
  stubFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return respond(200);
  });
  const result = await checkTarget({ name: 'a', url: 'https://a.test/', method: 'GET', expect: null, keyword: null, slowMs: 10, timeoutMs: 1000 });

  assert.equal(result.status, 'degraded');
  assert.match(result.error, /Slower than 10 ms/);
});

test('a missing keyword is down', async () => {
  stubFetch(() => respond(200, '{"status":"nope"}'));
  const result = await checkTarget({ name: 'a', url: 'https://a.test/', method: 'GET', expect: null, keyword: '"ok":true', slowMs: 5000, timeoutMs: 1000 });

  assert.equal(result.status, 'down');
  assert.match(result.error, /missing "\"ok\":true"|missing/);
});

test('a present keyword is up', async () => {
  stubFetch(() => respond(200, '{"ok":true}'));
  const result = await checkTarget({ name: 'a', url: 'https://a.test/', method: 'GET', expect: null, keyword: '"ok":true', slowMs: 5000, timeoutMs: 1000 });
  assert.equal(result.status, 'up');
});

test('a timeout is down and says so', async () => {
  globalThis.fetch = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });

  const result = await checkTarget({ name: 'a', url: 'https://a.test/', method: 'GET', expect: null, keyword: null, slowMs: 5000, timeoutMs: 40 });
  assert.equal(result.status, 'down');
  assert.equal(result.error, 'Timed out after 40 ms');
  assert.equal(result.code, null);
});

test('a network error is down and keeps the message', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND a.test') });
  };
  const result = await checkTarget({ name: 'a', url: 'https://a.test/', method: 'GET', expect: null, keyword: null, slowMs: 5000, timeoutMs: 1000 });

  assert.equal(result.status, 'down');
  assert.match(result.error, /fetch failed/);
  assert.match(result.error, /ENOTFOUND/);
});

test('HEAD falls back to GET when the server rejects HEAD', async () => {
  const calls = stubFetch((url, init) => (init.method === 'HEAD' ? respond(405) : respond(200)));
  const result = await checkTarget({ name: 'a', url: 'https://a.test/', method: 'HEAD', expect: null, keyword: null, slowMs: 5000, timeoutMs: 1000 });

  assert.equal(result.status, 'up');
  assert.equal(result.code, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'HEAD');
  assert.equal(calls[1].init.method, 'GET');
});

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

test('summarize picks the worst state', () => {
  assert.equal(summarize([{ status: 'up' }, { status: 'up' }]).status, 'operational');
  assert.equal(summarize([{ status: 'up' }, { status: 'degraded' }]).status, 'degraded');
  assert.equal(summarize([{ status: 'degraded' }, { status: 'down' }]).status, 'outage');
  assert.deepEqual(summarize([{ status: 'up' }, { status: 'down' }]).summary, { total: 2, up: 1, degraded: 0, down: 1 });
});

test('uptimeOf needs at least two samples', () => {
  assert.equal(uptimeOf([]), null);
  assert.equal(uptimeOf([{ t: 1, ok: 1 }]), null);
  assert.equal(uptimeOf([{ t: 1, ok: 1 }, { t: 2, ok: 1 }, { t: 3, ok: 1 }, { t: 4, ok: 0 }]), 75);
});

/* -------------------------------------------------------------------------- */
/* HTTP surface                                                               */
/* -------------------------------------------------------------------------- */

const ENV = {
  TARGETS: JSON.stringify([
    { name: 'Healthy', url: 'https://healthy.test/', expect: [200] },
    { name: 'Broken', url: 'https://broken.test/', expect: [200] },
  ]),
  CACHE_TTL: '30',
};

function stubHealth() {
  return stubFetch((url) => (url.includes('broken') ? respond(503, 'nope') : respond(200, 'fine')));
}

test('GET / renders the dashboard', async () => {
  stubHealth();
  const response = await worker.fetch(new Request('https://status.test/'), ENV, ctx());
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(html, /<title>Edge Status<\/title>/);
  assert.match(html, /Healthy/);
  assert.match(html, /Broken/);
  assert.match(html, /Major outage/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
});

test('GET /api/status returns the documented JSON shape', async () => {
  stubHealth();
  const response = await worker.fetch(new Request('https://status.test/api/status'), ENV, ctx());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(body.status, 'outage');
  assert.equal(body.ok, false);
  assert.equal(body.version, '1.0.0');
  assert.equal(body.summary.total, 2);
  assert.deepEqual(body.summary, { total: 2, up: 1, degraded: 0, down: 1 });
  assert.equal(body.targets[0].status, 'up');
  assert.equal(body.targets[1].status, 'down');
  assert.equal(body.targets[1].code, 503);
  assert.ok(body.updatedAt);
});

test('GET /api/status?pretty=1 indents the JSON', async () => {
  stubHealth();
  const response = await worker.fetch(new Request('https://status.test/api/status?pretty=1'), ENV, ctx());
  const text = await response.text();
  assert.match(text, /\n  "status"/);
});

test('/health is 200 when everything is up and 503 during an outage', async () => {
  stubHealth();
  const bad = await worker.fetch(new Request('https://status.test/health'), ENV, ctx());
  assert.equal(bad.status, 503);

  resetCache();
  stubFetch(() => respond(200));
  const good = await worker.fetch(new Request('https://status.test/health'), ENV, ctx());
  assert.equal(good.status, 200);
  assert.equal(await good.text(), 'OK\n');
});

test('results are cached between requests', async () => {
  const calls = stubHealth();
  await worker.fetch(new Request('https://status.test/api/status'), ENV, ctx());
  const second = await worker.fetch(new Request('https://status.test/api/status'), ENV, ctx());
  const body = await second.json();

  assert.equal(calls.length, 2, 'two targets, one round of checks');
  assert.equal(body.cached, true);
});

test('a target name cannot inject HTML', async () => {
  stubFetch(() => respond(200));
  const env = { TARGETS: JSON.stringify([{ name: '<img src=x onerror=alert(1)>', url: 'https://x.test/' }]) };
  const response = await worker.fetch(new Request('https://status.test/'), env, ctx());
  const html = await response.text();

  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('an error message cannot inject HTML either', async () => {
  globalThis.fetch = async () => {
    throw new Error('<script>alert(1)</script>');
  };
  const env = { TARGETS: JSON.stringify([{ name: 'X', url: 'https://x.test/' }]) };
  const html = await (await worker.fetch(new Request('https://status.test/'), env, ctx())).text();
  assert.ok(!html.includes('<script>alert(1)</script>'));
});

test('renders a setup hint when no target is configured', async () => {
  const response = await worker.fetch(new Request('https://status.test/'), { TARGETS: '[]' }, ctx());
  const html = await response.text();
  assert.match(html, /No targets configured/);
  assert.match(html, /&quot;name&quot;|"name"/);
});

test('unknown routes and bad methods are handled', async () => {
  const notFound = await worker.fetch(new Request('https://status.test/nope'), ENV, ctx());
  assert.equal(notFound.status, 404);

  const post = await worker.fetch(new Request('https://status.test/api/status', { method: 'POST' }), ENV, ctx());
  assert.equal(post.status, 405);

  const preflight = await worker.fetch(new Request('https://status.test/api/status', { method: 'OPTIONS' }), ENV, ctx());
  assert.equal(preflight.status, 204);

  const robots = await worker.fetch(new Request('https://status.test/robots.txt'), ENV, ctx());
  assert.match(await robots.text(), /Disallow: \//);
});

test('renderPage works with an empty payload', () => {
  const html = renderPage(
    { status: 'outage', ok: false, title: 'Edge Status', updatedAt: '2026-01-01T00:00:00.000Z', summary: { total: 0, up: 0, degraded: 0, down: 0 }, targets: [] },
    parseConfig({}),
  );
  assert.match(html, /No targets configured/);
});
