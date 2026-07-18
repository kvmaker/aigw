# ai-gw

Anthropic 协议路由器（Bun 版），1:1 移植自 `cloudflare-ai-gw`（ccc-router Worker）。
接收 `/v1/messages`，按 `body.model` 路由到 minimax / glm / ark 上游，SSE 流式透传。

## 本地开发

```bash
bun install
cp .env.example .env   # 填入真实 token
bun run dev            # 监听 127.0.0.1:8787
bun test               # 跑测试
```

## 路由表（内置默认）

| model（normalize 后） | upstream | baseUrl | upstreamId |
|---|---|---|---|
| `glm-5.2[1m]` / `glm-5.2` | glm | `https://open.bigmodel.cn/api/anthropic` | `GLM-5.2` |
| `minimax-m3[1m]` / `minimax-m3` | minimax | `https://api.minimaxi.com/anthropic` | `MiniMax-M3[1m]` |
| `minimax-m2.7-highspeed` | minimax | `https://api.minimaxi.com/anthropic` | `MiniMax-M2.7-highspeed` |
| `kimi-k3[1m]` / `kimi-k3` | ark | `https://ark.cn-beijing.volces.com/api/plan` | `kimi-k3` |

> 关键：
> - GLM 上游不认 `[1m]` 后缀，转发前会把 `body.model` 重写为 `upstreamId`。
> - ark（火山方舟）走「Agent Plan」套餐专属端点 `/api/plan`，该 key 在标准端点 `/api/v3/anthropic` 上不被接受。

## Fallback（上游容错）

路由表支持「主 + 备」候选链：主上游失败时按序尝试 `fallbacks`，命中首个成功的响应即返回，对客户端透明。通过 `CCC_ROUTES` 配置（`DEFAULT_ROUTES` 不预置 fallback）：

```json
[
  {
    "aliases": ["kimi-k3", "kimi-k3[1m]"],
    "baseUrl": "https://ark.cn-beijing.volces.com/api/plan",
    "secret": "CCC_ARK_AUTH_TOKEN",
    "upstreamId": "kimi-k3",
    "fallbacks": [
      {
        "baseUrl": "https://open.bigmodel.cn/api/anthropic",
        "secret": "CCC_GLM_AUTH_TOKEN",
        "upstreamId": "GLM-5.2"
      }
    ]
  }
]
```

**失败判定**（只看 HTTP status，不读 body）：

| 上游响应 | 是否 fallback |
|---|---|
| `fetch` 抛错（网络错误） | ✅ |
| 5xx | ✅ |
| 429 / 529（限流 / 过载） | ✅ |
| 4xx（含 401/403，客户端错误） | ❌ 原样透传 |

**终态**：
- 单上游（未配 fallback）：行为不变——5xx/429 原样透传，网络错返回 502，secret 缺失返回 500。
- 多候选：首个 2xx 或 4xx 透传并停止；所有候选都失败时返回**聚合 502**，body 含每个候选的 `baseUrl / status / message`，便于排查。

**per-candidate model 重写**：每个候选按自己的 `upstreamId` 重写 `body.model`，支持跨 provider 链（如 kimi-k3 主 → GLM 备）。注意 fallback 到不同模型时，输出质量 / 能力可能存在差异。

**已知限制**：
- fallback 仅在「拿到上游 Response headers 之前」生效。一旦开始 SSE 流式透传（客户端已收到首字节），上游中断无法回退——这是 SSE 固有限制。
- gw→upstream 的 `fetch` 暂无超时（待 B02）。上游建连成功但 hang 住不返首字节时 `fetch` 不会抛错，fallback 不会触发。

## 部署（gz-a100）

见 `docs/superpowers/plans/2026-07-16-ai-gw-bun.md` Task 7。

- bun 进程：`deploy/ai-gw.service`（systemd 管理）
- 反代 + TLS：`caddy/Caddyfile`（Caddy 自动签 LE 证书）
- 域名：`aigw.kvmaker.cn` → 1.12.240.16（灰云直连）
