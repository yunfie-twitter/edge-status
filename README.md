# edge-status

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](#)
[![Tests](https://img.shields.io/badge/tests-25%20passing-brightgreen)](test/worker.test.js)

A status page and health-check API in **one file**, running on Cloudflare Workers' edge.

Point it at the endpoints you care about and you get a clean, responsive dashboard, a JSON
feed for badges and scripts, and a `/health` probe that answers 200 or 503 — with no build
step, no database and no dependencies.

> 中文文档：[README_CN.md](README_CN.md)

## Why

Most status pages are a hosted service with a monthly bill, or a VPS running a monitor that
can go down with the thing it monitors. `edge-status` checks from Cloudflare's network, costs
nothing on the free plan, and is a single ES module you can read in five minutes.

## Features

- **Multi-target monitoring** — any HTTP/HTTPS URL, `GET` or `HEAD`, custom accepted status codes.
- **Latency aware** — every check is timed; a target slower than its threshold shows as *degraded* instead of failing silently.
- **Content checks** — require a keyword in the response body (e.g. `"ok":true`).
- **Three states** — `up`, `degraded`, `down`, rolled up into `operational` / `degraded` / `outage`.
- **Dashboard** — responsive card grid, light/dark aware, live refresh, no framework, no external assets.
- **JSON API** — `/api/status` with `Access-Control-Allow-Origin: *`, safe to call from a browser or a build script.
- **`/health` probe** — 200 `OK` or 503, for uptime checks *of the monitor itself*.
- **Smart caching** — results are shared by every visitor for `CACHE_TTL` seconds, so a popular status page still checks each target once per interval.
- **Optional uptime history** — bind a KV namespace and get a 60-sample bar chart per target. Without it everything else works.
- **Zero dependencies** — one `src/index.js`, no bundler.

## Quick start

### Deploy from the dashboard

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hjddl/edge-status)

Cloudflare clones the repo into your account, keeps `wrangler.toml` as the starting config and
gives you a `*.workers.dev` URL.

### Deploy with Wrangler

```bash
git clone https://github.com/hjddl/edge-status.git
cd edge-status
npm install          # installs wrangler only
npx wrangler login
npm run deploy
```

### Local development

```bash
npm run dev          # http://localhost:8787
npm test             # 25 unit tests, no network needed
```

## Configuration

Everything lives in the `[vars]` block of `wrangler.toml` (or in the dashboard: *Worker → Settings →
Variables*). All of them are optional.

| Variable | Default | Description |
| --- | --- | --- |
| `TARGETS` | demo targets | JSON array of monitored targets (see below) |
| `PAGE_TITLE` | `Edge Status` | Title used by the page and the JSON payload |
| `SLOW_MS` | `800` | Default latency above which a target is `degraded` |
| `TIMEOUT_MS` | `8000` | Default request timeout in milliseconds |
| `CACHE_TTL` | `30` | Seconds a check result is reused for all visitors |
| `REFRESH_SECONDS` | `30` | Browser auto-refresh interval |
| `HISTORY_SIZE` | `60` | Samples kept per target when KV is bound |
| `HISTORY_INTERVAL_MS` | `300000` | Minimum gap between two history samples (5 min) |
| `HIDE_LATENCY` | `false` | Set to `true` to hide latency figures on the page |

### Targets

`TARGETS` is a JSON array. Only `url` is required.

```toml
TARGETS = '[{"name":"My API","url":"https://api.example.com/health","expect":[200],"slowMs":400}]'
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | URL hostname | Display name |
| `url` | string | — | `http(s)` endpoint to check (required) |
| `method` | string | `GET` | `GET` or `HEAD`. `HEAD` that returns 405/501 is retried as `GET` |
| `expect` | number[] | any `2xx` | Acceptable status codes, e.g. `[200, 204]` |
| `keyword` | string | — | Text the response body must contain |
| `slowMs` | number | `SLOW_MS` | Per-target degraded threshold |
| `timeoutMs` | number | `TIMEOUT_MS` | Per-target timeout |

Targets with an invalid or non-HTTP URL are ignored, and a broken `TARGETS` string falls back
to the demo targets instead of breaking the page. Up to 25 targets are checked per run.

A richer example:

```toml
TARGETS = '''[
  {"name":"Website","url":"https://example.com","expect":[200],"slowMs":600},
  {"name":"API health","url":"https://api.example.com/health","expect":[200],"keyword":"\\"status\\":\\"ok\\"","slowMs":400,"timeoutMs":3000},
  {"name":"CDN edge","url":"https://cdn.example.com/pixel.gif","method":"HEAD"}
]'''
```

## Endpoints

| Route | What it returns |
| --- | --- |
| `GET /` | HTML dashboard (auto-refreshes in the browser) |
| `GET /api/status` | JSON status document, CORS enabled |
| `GET /api/status?pretty=1` | Same, indented |
| `GET /api/status?fresh=1` | Re-checks now instead of using the cache |
| `GET /health` | `200 OK` when everything is up, `503` otherwise |
| `GET /robots.txt` | `Disallow: /` |

`/health` is handy for chaining: put an external uptime checker on it and you get an alert when
the status page itself stops responding.

### JSON response

```json
{
  "status": "degraded",
  "ok": false,
  "title": "Edge Status",
  "updatedAt": "2026-11-20T14:42:10.512Z",
  "summary": { "total": 2, "up": 1, "degraded": 1, "down": 0 },
  "targets": [
    {
      "name": "Website",
      "url": "https://example.com/",
      "status": "up",
      "code": 200,
      "latencyMs": 48,
      "checkedAt": "2026-11-20T14:42:10.510Z",
      "error": null,
      "uptime": 99.4,
      "history": [{ "at": "2026-11-20T14:37:10.000Z", "ok": true, "latencyMs": 44 }]
    },
    {
      "name": "API health",
      "url": "https://api.example.com/health",
      "status": "degraded",
      "code": 200,
      "latencyMs": 912,
      "checkedAt": "2026-11-20T14:42:10.511Z",
      "error": "Slower than 400 ms",
      "uptime": 97.1,
      "history": []
    }
  ],
  "cached": false,
  "version": "1.0.0"
}
```

`status` is one of `up` / `degraded` / `down` per target, and `operational` / `degraded` /
`outage` overall. `uptime` is `null` until at least two history samples exist (requires KV).
`code` and `latencyMs` are `null` when no response was received.

## Optional: uptime history

Bind a KV namespace to keep a rolling history and draw the bar chart:

```bash
npx wrangler kv namespace create EDGE_STATUS_KV
```

Then uncomment the block at the bottom of `wrangler.toml` and paste the printed `id`:

```toml
[[kv_namespaces]]
binding = "EDGE_STATUS_KV"
id = "<your-namespace-id>"
```

One sample is written per target at most every `HISTORY_INTERVAL_MS` (5 minutes by default), so a
handful of targets stay well inside the free tier's daily KV write allowance. History expires
after 7 days. Without the binding the page shows `—` for uptime and everything else is unchanged.

## Cost

The free plan covers 100,000 requests per day and 10 ms CPU per request. A check of three targets
is a few milliseconds of CPU, and `CACHE_TTL` keeps the real work to one round of checks per
interval regardless of traffic.

## Notes and limits

- Checks run from the edge location that serves the request, so latency is *from that PoP*, not from your laptop.
- The cache is per colo; different regions may briefly show slightly different numbers.
- No alerting, no accounts, no persistence beyond the optional KV history. It tells you the current truth, not the history of it.
- Cloudflare Workers cannot make requests to private networks or `localhost`.

## Development

```
src/index.js        the whole Worker
test/worker.test.js unit tests (node:test, fetch stubbed)
wrangler.toml       configuration
docs/ci-workflow.yml a sample GitHub Actions workflow: copy it to .github/workflows/ci.yml
```

`npm test` runs on plain Node 18+ with `fetch` stubbed, covering config parsing, every probe
outcome, aggregation, caching and HTML escaping.

## License

[MIT](LICENSE) © hjddl
