# CLAUDE.md

ai-gw — Anthropic 协议路由器（Bun 版）。接收 `/v1/messages`，按 `body.model` 路由到上游（GLM / minimax / ark），SSE 流式透传。1:1 移植自 cloudflare-ai-gw（ccc-router Worker）。

## 命令

```bash
bun install          # 安装依赖
bun run dev          # 启动，监听 127.0.0.1:8787（= bun run start）
bun test             # 跑测试（92 个，test/ 下 4 个文件）
```

> `bun` 可能不在 PATH，用 `~/.bun/bin/bun`。

## 架构

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 入口：`routeRequest` 分发 + `Bun.serve`（仅 `import.meta.main` 时启动，便于测试 import） |
| `src/config.ts` | 路由表 `DEFAULT_ROUTES`、`loadConfig`（三层合并：内置 / YAML / env JSON）、`normalizeModel`、YAML schema 校验 |
| `src/handlers.ts` | 核心 `handleMessages`：model 路由、重写、注入 secret、SSE 透传、上游 fallback |
| `src/auth.ts` | Bearer 认证（constant-time 比较）+ CORS |

链路：`POST /v1/messages` → `verifyBearer` → `handleMessages` → 按 `normalizeModel(body.model)` 查表 → 重写 model 为 `upstreamId` → 注入 `x-api-key` → 转发 `${baseUrl}/v1/messages` → 透传响应（含 SSE）。

## 环境变量（.env，已 gitignore）

- `CCC_ROUTER_TOKEN` — gateway 自身 Bearer token
- `CCC_MINIMAX_AUTH_TOKEN` / `CCC_GLM_AUTH_TOKEN` / `CCC_ARK_AUTH_TOKEN` — 上游 secret（强制 BYOK，忽略 client 带来的 token）
- `CCC_ROUTES` — 可选，JSON 数组，合并覆盖 `DEFAULT_ROUTES`
- `CCC_CONFIG_FILE` — 可选，YAML 路由配置文件路径（B01）；优先级 `DEFAULT_ROUTES < CCC_CONFIG_FILE(YAML) < CCC_ROUTES`，加载时 schema 校验，非法 fail-fast。参考 `ai-gw.example.yaml`
- `PORT`（默认 8787）/ `HOST`（默认 127.0.0.1）

## 关键 Gotchas（踩过的坑，勿重复）

1. **`Bun.serve` 默认 `idleTimeout=10s`**：推理模型（kimi-k3）thinking + 长输出跨度可达 10-20s，会被空闲超时切断（客户端报 "Connection closed mid-response"）。`src/index.ts` 已设 `idleTimeout: 255`（Bun 上限）——**改 SSE/超时代码务必保留此行**。
2. **handlers 自动拼 `/v1/messages`**：`baseUrl` 不要带 `/v1/messages`。
3. **ark 走专属端点 `/api/plan`**：火山方舟「Agent Plan」套餐专用；该 key 在标准端点 `/api/v3/anthropic` 上 401。model 名直接用 `kimi-k3`（无需 endpoint id）。
4. **`normalizeModel` 剥 `[1m]` 后缀 + 小写**：路由匹配用 normalize 后的 key；`DEFAULT_ROUTES` 里带 `[1m]` 的 key 是死代码（normalize 后查不到），保留仅为表意。
5. **model 重写**：client 发别名（`kimi-k3[1m]`），转发前重写为 `upstreamId`（`kimi-k3`）——上游不认 `[1m]`。
6. **fallback 仅在开始透传响应 body 首字节前生效**：判定只看 HTTP status（5xx / 429 / 529 触发，4xx 不触发），不读 body——SSE 一旦开始流式透传就无法回退。聚合 502 / config_error 已 sanitized，不向客户端泄露 baseUrl / 异常文本 / upstream 正文。gw→upstream 的 `fetch` 暂无超时（待 B02 TODO），上游 hang 住不抛错时 fallback 不触发。单上游（无 `fallbacks`）行为等价于旧版。
7. **YAML 配置层用 `secretKey`（不是 env JSON 的 `secret`）**：YAML（`ai-gw.example.yaml`）与内部 `Upstream` 对齐用 `secretKey` 字段，env JSON（`CCC_ROUTES`）用 `secret`——两者字段名不同，加载时各自映射。`secretKey` 的值是 env 变量名（如 `CCC_ARK_AUTH_TOKEN`），真实 token 仍只在 `.env`。优先级 `DEFAULT_ROUTES < CCC_CONFIG_FILE(YAML) < CCC_ROUTES`；YAML schema 非法（缺字段 / baseUrl 非 http(s) / 空数组）会 fail-fast 抛 `ConfigError` 拒绝启动。顶层支持 `{routes:[...]}` 或直接数组两种形态。顶层可选 `upstreams:` 块给每个上游命名（三元组定义一次），route 的 `upstream` / `fallbacks` 支持字符串引用或内联对象（向后兼容）；引用未定义的名字 fail-fast。重名 key 由 yaml parser 直接报 `Map keys must be unique`。

## 部署（gz-a100，systemd + caddy）

远端 `/home/ubuntu/ai-gw`（**非 git 仓库**，只能 rsync，不能 git pull）。

```bash
# 同步代码（必须 --exclude='.env'，否则会覆盖线上真实 token，全挂！）
rsync -avz --exclude='node_modules' --exclude='.git' --exclude='.env' \
  ~/work/aigw/ gz-a100:/home/ubuntu/ai-gw/
ssh gz-a100 'sudo systemctl restart ai-gw'
curl -s https://aigw.kvmaker.cn/   # /health 应列出 supported_models
```

- systemd：`deploy/ai-gw.service`（`Restart=always`）
- caddy：`caddy/Caddyfile`（`aigw.kvmaker.cn` → `127.0.0.1:8787`，`flush_interval -1` SSE 友好，自动 LE 证书）

## 测试

`bun test`：全部用 mock env / mock fetch，不依赖真实 token，可安全运行。改路由表后必跑，并补 `test/config.test.ts` 断言。

## 相关

- 客户端启动器：`~/.bin/ccc-gz`（混合配置，走 `aigw.kvmaker.cn`）
- TODO 管理：`docs/todo/`（用 `/todo` 命令）
