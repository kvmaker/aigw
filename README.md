# ai-gw

Anthropic 协议路由器（Bun 版），1:1 移植自 `cloudflare-ai-gw`（ccc-router Worker）。
接收 `/v1/messages`，按 `body.model` 路由到 minimax / glm 上游，SSE 流式透传。

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

> 关键：GLM 上游不认 `[1m]` 后缀，转发前会把 `body.model` 重写为 `upstreamId`。

## 部署（gz-a100）

见 `docs/superpowers/plans/2026-07-16-ai-gw-bun.md` Task 7。

- bun 进程：`deploy/ai-gw.service`（systemd 管理）
- 反代 + TLS：`caddy/Caddyfile`（Caddy 自动签 LE 证书）
- 域名：`aigw.kvmaker.cn` → 1.12.240.16（灰云直连）
