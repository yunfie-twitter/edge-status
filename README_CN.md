# edge-status

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](#)
[![Tests](https://img.shields.io/badge/tests-25%20passing-brightgreen)](test/worker.test.js)

**一个文件**就能跑在 Cloudflare Workers 边缘网络上的状态监控页 + 健康检查接口。

把要盯的网址填进去，就能得到一个干净、响应式的状态看板，一份给脚本和徽章用的 JSON，
以及一个返回 200/503 的 `/health` 探针——不用打包、不用数据库、没有任何依赖。

> English docs: [README.md](README.md)

## 为什么写它

现成的状态页要么是按月付费的托管服务，要么是一台 VPS 上跑的监控程序——而它自己也会挂。
`edge-status` 从 Cloudflare 的网络上发起检查，免费额度就够用，整个 Worker 只有一个 ES Module，
五分钟能读完。

## 功能

- **多目标监控**：任意 HTTP/HTTPS 地址，支持 `GET` / `HEAD` 和自定义可接受状态码。
- **延迟感知**：每次检查都计时，超过阈值会标成 *degraded*（降级），而不是静静地说「正常」。
- **内容校验**：可以要求响应体包含某个关键字（例如 `"ok":true`）。
- **三种状态**：单目标 `up` / `degraded` / `down`，汇总为 `operational` / `degraded` / `outage`。
- **状态看板**：响应式卡片、自动适配深浅色、定时自动刷新，无框架、无外部资源。
- **JSON 接口**：`/api/status`，带 `Access-Control-Allow-Origin: *`，浏览器和构建脚本都能直接用。
- **`/health` 探针**：返回 200 `OK` 或 503，用来监控「监控页自己」。
- **三级缓存**：同一份结果在 `CACHE_TTL` 秒内被所有访客共用，访问量再大也只按间隔检查一次。
- **可选的可用率历史**：绑定一个 KV 命名空间即可得到每个目标最近 60 次的柱状图；不绑定也不影响其他功能。
- **零依赖**：只有 `src/index.js`，不需要构建。

## 快速开始

### 在 Cloudflare 控制台一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hjddl/edge-status)

Cloudflare 会把仓库复制到你的账号下，用 `wrangler.toml` 作为初始配置，并分配一个
`*.workers.dev` 地址。

### 用 Wrangler 部署

```bash
git clone https://github.com/hjddl/edge-status.git
cd edge-status
npm install          # 只装 wrangler
npx wrangler login
npm run deploy
```

### 本地开发

```bash
npm run dev          # http://localhost:8787
npm test             # 25 个单元测试，不需要联网
```

## 配置

所有配置都在 `wrangler.toml` 的 `[vars]` 里（也可以改在控制台 *Worker → Settings → Variables*），
全部可选。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TARGETS` | 示例目标 | 监控目标的 JSON 数组（见下） |
| `PAGE_TITLE` | `Edge Status` | 页面标题和 JSON 里的标题 |
| `SLOW_MS` | `800` | 默认的降级延迟阈值（毫秒） |
| `TIMEOUT_MS` | `8000` | 默认请求超时（毫秒） |
| `CACHE_TTL` | `30` | 检查结果被所有访客复用的秒数 |
| `REFRESH_SECONDS` | `30` | 页面自动刷新间隔 |
| `HISTORY_SIZE` | `60` | 绑定 KV 时每个目标保留的采样数 |
| `HISTORY_INTERVAL_MS` | `300000` | 两次历史采样的最小间隔（5 分钟） |
| `HIDE_LATENCY` | `false` | 设为 `true` 则页面不显示延迟 |

### 监控目标

`TARGETS` 是一个 JSON 数组，只有 `url` 必填。

```toml
TARGETS = '[{"name":"我的接口","url":"https://api.example.com/health","expect":[200],"slowMs":400}]'
```

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `name` | string | URL 主机名 | 显示名称 |
| `url` | string | — | 要检查的 `http(s)` 地址（必填） |
| `method` | string | `GET` | `GET` 或 `HEAD`；`HEAD` 遇到 405/501 会自动改用 `GET` 重试 |
| `expect` | number[] | 任意 `2xx` | 可接受的状态码，如 `[200, 204]` |
| `keyword` | string | — | 响应体必须包含的文字 |
| `slowMs` | number | `SLOW_MS` | 该目标的降级阈值 |
| `timeoutMs` | number | `TIMEOUT_MS` | 该目标的超时 |

非法或非 HTTP 的地址会被忽略；`TARGETS` 写坏时回退到示例目标，而不是让整页报错。
每次最多检查 25 个目标。

更完整的例子：

```toml
TARGETS = '''[
  {"name":"官网","url":"https://example.com","expect":[200],"slowMs":600},
  {"name":"接口健康","url":"https://api.example.com/health","expect":[200],"keyword":"\\"status\\":\\"ok\\"","slowMs":400,"timeoutMs":3000},
  {"name":"CDN 节点","url":"https://cdn.example.com/pixel.gif","method":"HEAD"}
]'''
```

## 接口

| 路由 | 返回 |
| --- | --- |
| `GET /` | HTML 状态看板（自动刷新） |
| `GET /api/status` | JSON 状态文档，已开放 CORS |
| `GET /api/status?pretty=1` | 同上，带缩进 |
| `GET /api/status?fresh=1` | 跳过缓存，立即重新检查 |
| `GET /health` | 全部正常返回 `200 OK`，否则 `503` |
| `GET /robots.txt` | `Disallow: /` |

`/health` 很适合串起来用：给外部监控挂在它上面，状态页本身不响应时你就能收到告警。

### JSON 结构

```json
{
  "status": "degraded",
  "ok": false,
  "title": "Edge Status",
  "updatedAt": "2026-11-20T14:42:10.512Z",
  "summary": { "total": 2, "up": 1, "degraded": 1, "down": 0 },
  "targets": [
    {
      "name": "官网",
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
      "name": "接口健康",
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

单目标 `status` 为 `up` / `degraded` / `down`，总体为 `operational` / `degraded` / `outage`。
`uptime` 在历史样本不足两个时为 `null`（需要绑定 KV）；没拿到响应时 `code` 和 `latencyMs` 为 `null`。

## 可选：可用率历史

绑定 KV 命名空间即可保留滚动历史并画出柱状图：

```bash
npx wrangler kv namespace create EDGE_STATUS_KV
```

然后取消 `wrangler.toml` 末尾那段注释，把打印出的 `id` 填进去：

```toml
[[kv_namespaces]]
binding = "EDGE_STATUS_KV"
id = "<你的命名空间 id>"
```

每个目标最多每 `HISTORY_INTERVAL_MS`（默认 5 分钟）写入一条采样，几个目标远在免费额度之内；
历史 7 天后过期。不绑定的话，可用率一栏显示 `—`，其他功能不受影响。

## 成本

免费计划每天 10 万请求、每次请求 10ms CPU。检查三个目标只消耗几毫秒 CPU，再加上
`CACHE_TTL`，无论访问量多大，真正发出去的检查都只有每个间隔一次。

## 说明与限制

- 检查从「处理这次请求的边缘节点」发起，所以延迟是那个 PoP 的延迟，不是你本机的。
- 缓存按机房隔离，不同地区短时间内可能出现略有差异的数字。
- 没有告警、没有账号、除可选的 KV 历史外不做持久化——它告诉你此刻的真相，不负责记录过去。
- Workers 无法访问内网或 `localhost`。

## 开发

```
src/index.js        整个 Worker
test/worker.test.js 单元测试（node:test，stub 掉 fetch）
wrangler.toml       配置
docs/ci-workflow.yml 一份 GitHub Actions 示例：复制到 .github/workflows/ci.yml 即可启用
```

`npm test` 在原生 Node 18+ 上运行，覆盖配置解析、各种探测结果、汇总、缓存和 HTML 转义。

## 许可证

[MIT](LICENSE) © hjddl
