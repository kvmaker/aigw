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

## 配置来源（路由表三种来源 + 优先级）

路由表有三个来源，按优先级合并（后者覆盖前者同名 key）：

| 优先级 | 来源 | 适用场景 |
|---|---|---|
| 低 | `DEFAULT_ROUTES`（`src/config.ts` 硬编码） | 内置兜底，改它需改代码 + 重新部署 |
| 中 | YAML 文件（`CCC_CONFIG_FILE` 指向） | **推荐**：可读、可注释、适合 fallback 链等嵌套结构 |
| 高 | `CCC_ROUTES`（env JSON 数组字符串） | 临时覆盖 / 快速 hotfix，可读性差 |

### YAML 配置（推荐）

复制示例文件并按需修改，再用 `CCC_CONFIG_FILE` 指向它：

```bash
cp ai-gw.example.yaml ai-gw.yaml
# 编辑 ai-gw.yaml 后启动
CCC_CONFIG_FILE=./ai-gw.yaml bun run dev
```

YAML schema（与 [Fallback](#fallback上游容错) 数据结构对齐）：

```yaml
routes:
  - aliases: ["kimi-k3", "kimi-k3[1m]"]
    upstream:
      baseUrl: https://ark.cn-beijing.volces.com/api/plan
      secretKey: CCC_ARK_AUTH_TOKEN     # .env 里的变量名，不是真实 token
      upstreamId: kimi-k3
    fallbacks:                           # 可选
      - baseUrl: https://open.bigmodel.cn/api/anthropic
        secretKey: CCC_GLM_AUTH_TOKEN
        upstreamId: GLM-5.2
```

加载时做 schema 校验（`aliases` 非空、`baseUrl` 合法 http(s) URL、`secretKey`/`upstreamId` 非空），非法配置 fail-fast 拒绝启动。`secretKey` 写环境变量名，真实 token 依旧只在 `.env`。

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
- 多候选：首个 2xx 或 4xx 透传并停止；所有候选都失败时返回**聚合 502**（已脱敏），body 只含每个候选的 `index / reason / status`，**不泄露** `baseUrl`、异常文本或上游正文（完整错误仅供服务端日志）。

**per-candidate model 重写**：每个候选按自己的 `upstreamId` 重写 `body.model`，支持跨 provider 链（如 kimi-k3 主 → GLM 备）。注意 fallback 到不同模型时，输出质量 / 能力可能存在差异。

**已知限制**：
- fallback 仅在「开始向客户端透传上游响应 body 的首字节之前」生效（判定靠 HTTP status）。一旦开始 SSE 流式透传（客户端已收到首字节），上游中断无法回退——这是 SSE 固有限制。
- gw→upstream 的 `fetch` 暂无超时（待 B02）。上游建连成功但 hang 住不返首字节时 `fetch` 不会抛错，fallback 不会触发。

## 部署（gz-a100）

见 `docs/superpowers/plans/2026-07-16-ai-gw-bun.md` Task 7。

- bun 进程：`deploy/ai-gw.service`（systemd 管理）
- 反代 + TLS：`caddy/Caddyfile`（Caddy 自动签 LE 证书）
- 域名：`aigw.kvmaker.cn` → 1.12.240.16（灰云直连）
