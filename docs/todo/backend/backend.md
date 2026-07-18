# backend TODO

ai-gw 后端路由/转发核心逻辑：路由表、model 重写、BYOK secret 注入、SSE 透传、容错（fallback / 重试）等。

---

## B00. 添加模型 fallback 的能力 `[x]` -- P1

**现状**：当前 `src/handlers.ts:handleMessages` 一次只命中一个上游，失败直接 502/504 给客户端（`src/handlers.ts:103-122`）。当某个 provider（GLM / minimax / ark）故障或限流时，客户端（包括 Claude Code）会收到硬错误，且无自动恢复路径。

**目标**：实现上游失败时的自动 fallback：主 provider 不可用时按预定顺序切换到备用 provider，返回首个成功的响应。对客户端透明。

**方案**

路由表层面支持「provider 链」：每个路由 key 可声明多个候选 upstream（`baseUrl + secretKey + upstreamId`），按顺序尝试。handlers 顺序遍历，命中首个成功的响应即返回。

数据结构扩展（`src/config.ts`）：

```typescript
interface Upstream {
  baseUrl: string;
  secretKey: string;
  upstreamId: string;
}

interface RouteEntry {
  aliases: string[];
  fallbacks?: Upstream[]; // 备选上游，按顺序
}
```

判定「失败」→ 触发 fallback：

| 错误类型 | 是否 fallback |
|---|---|
| 网络错误（`fetch` throw） | ✅ |
| 上游 5xx | ✅ |
| 429 / 529（限流 / 过载） | ✅ |
| 4xx 客户端错误 | ❌（避免把客户端的锅转嫁给备用 provider） |
| 401 / 403（认证失败） | ❌（备用 provider 也不会通） |

所有上游都失败 → 返回 502，body 聚合每个候选的最后错误信息。

**改动点**

- `src/config.ts`：路由表条目支持多上游（主 + `fallbacks` 数组），`loadRoutesFromEnv` 解析对应 JSON
- `src/handlers.ts`：`handleMessages` 改成顺序遍历所有上游，命中即返回；全部失败聚合 502
- `test/config.test.ts`：测试多上游解析 + `DEFAULT_ROUTES` 向后兼容（无 `fallbacks` 时行为不变）
- `test/handlers.test.ts`：测试 fallback 触发（主 5xx → 备 200；主 429 → 备 200；4xx 不 fallback；全部失败 → 502）
- `README.md`：路由表文档扩展多上游格式

**收益**：provider 故障期间用户无感切换，Claude Code 不再因单 provider 抖动而中断任务。

**风险**

- **计费 / 归因**：fallback 后实际调用的是备用 provider，客户端账单的 provider 可能与预期不符
- **鉴权**：备用 provider 的 secret 必须在 `secrets` 里配置好；缺失时跳过该候选并继续
- **模型名假设**：fallback 候选必须支持相同 `upstreamId`（如 `kimi-k3` 主 → 备也用 `kimi-k3`），否则需 per-candidate `upstreamId` 重写

**依赖**：无

**实施记录**（2026-07-18，分支 `todo/b00-model-fallback`）：
- `src/config.ts`：`Upstream` 加 `fallbacks?`、`RouteEntry` 加 `fallbacks?`、`loadRoutesFromEnv` 经 `toUpstream` 递归映射；`DEFAULT_ROUTES` 不变
- `src/handlers.ts`：抽 `passthroughResponse` / `shouldFallback` / `aggregate502`；`handleMessages` 改候选链循环，用 `multi` 区分单/多候选（单候选完全向后兼容）；顺手修掉原 body 二次 parse
- 终态（已确认）：多候选全失败 → 聚合 502（带 candidates）；单候选 5xx/429 透传、网络错 502、secret 缺 500，均向后兼容
- 测试：45 → 60（config +3、handlers fallback +12），现有 11 个 handlers 用例作回归网未改
- fetch 超时拆为 **B02**
- 文档：README 新增「Fallback」小节、CLAUDE.md Gotchas 第 6 条

---

## B01. 增加使用 yaml 进行配置的能力 `[ ]` -- P2

**现状**：路由表目前有两处来源——`src/config.ts` 里硬编码的 `DEFAULT_ROUTES`（改路由要改代码、重新部署），以及 `CCC_ROUTES` 环境变量（JSON 数组字符串，塞在 `.env` 里，可读性差、无注释、无校验）。随着上游增多（GLM / minimax / ark）和 B00 fallback 引入「主 + 备」结构，JSON 字符串会越来越难维护。

**目标**：支持用 YAML 文件声明路由表（及未来的 gateway 配置），作为 `DEFAULT_ROUTES` 与 `CCC_ROUTES` 之外的第三种、也是首选的配置方式。YAML 可读性好、支持注释、适合表达嵌套的 fallback 链。

**方案**

新增可选配置文件（如 `ai-gw.yaml` 或 `config/routes.yaml`），通过 env 指定路径（如 `CCC_CONFIG_FILE`），缺省不启用、保持现有行为。加载优先级（后者覆盖前者）：

```
DEFAULT_ROUTES（内置兜底） < CCC_CONFIG_FILE 指向的 YAML < CCC_ROUTES（env JSON，最高优先，便于临时覆盖）
```

YAML 结构（与 B00 的 fallback 数据结构对齐）：

```yaml
# ai-gw.yaml
routes:
  - aliases: ["kimi-k3", "kimi-k3[1m]"]
    upstream:
      baseUrl: https://ark.cn-beijing.volces.com/api/plan
      secretKey: CCC_ARK_AUTH_TOKEN
      upstreamId: kimi-k3
    fallbacks:                      # 可选，B00 引入
      - baseUrl: https://open.bigmodel.cn/api/anthropic
        secretKey: CCC_GLM_AUTH_TOKEN
        upstreamId: GLM-5.2
  - aliases: ["glm-5.2", "glm-5.2[1m]"]
    upstream:
      baseUrl: https://open.bigmodel.cn/api/anthropic
      secretKey: CCC_GLM_AUTH_TOKEN
      upstreamId: GLM-5.2
```

实现要点：

- **解析**：Bun 生态用 `yaml`（npm 包）或 `js-yaml`。需新增依赖 → `package.json` + `bun.lock` 变更。优先选零依赖/轻量的 `yaml`。
- **校验**：加载时做 schema 校验（`aliases` 非空数组、`baseUrl` 是合法 URL、`secretKey`/`upstreamId` 非空字符串），非法配置给出明确报错并拒绝启动（fail-fast），避免带病运行。
- **secret 仍走 env**：YAML 里只写 `secretKey`（env 变量名），真实 token 依旧只在 `.env`，不入 YAML、不入库。
- **热加载（可选，P3）**：首版启动时加载一次即可；`SIGHUP` 或 watch 热重载可作为后续增强。

**改动点**

- `package.json` / `bun.lock`：新增 `yaml` 依赖
- `src/config.ts`：新增 `loadRoutesFromYaml(filePath)`，并在 `loadConfig` 里按上述优先级合并
- `ai-gw.example.yaml`：示例配置文件（入库，不含真实 secret）
- `test/config.test.ts`：YAML 解析、schema 校验（缺字段/非法 URL 报错）、三层优先级合并、缺省不启用时行为不变
- `README.md`：配置方式文档（三种来源 + 优先级 + YAML 示例）
- `deploy/`：systemd unit 如需挂载配置文件路径，补充说明

**收益**：路由/上游变更从「改代码 + 重新部署」降为「改 YAML + 重启（甚至热加载）」；fallback 链等嵌套结构可读、可注释、可 review。

**风险**

- **新增依赖**：引入 `yaml` 包，需评估体积与供应链（选主流、维护活跃的）
- **配置漂移**：YAML 与 `DEFAULT_ROUTES` 并存，需明确优先级并在文档写清，避免「改了 YAML 但没生效」（被更高优先的 `CCC_ROUTES` 覆盖）
- **schema 演进**：B00 fallback 结构若调整，YAML schema 需同步演进，注意版本兼容

**依赖**：无（但与 B00 的 fallback 数据结构强相关，建议 B00 先定稿数据结构，或两者一起设计）

---

## B02. 给 gw→upstream fetch 加超时，让 fallback 覆盖上游 hang 场景 `[ ]` -- P1

**现状**：B00 的 fallback 仅在 `fetch` 抛错或上游返回 5xx/429/529 时触发。但 gw→upstream 的 `fetch` 没有任何超时——`Bun.serve` 的 `idleTimeout: 255` 只管 client↔gw。生产中常见的「TCP 建连成功、上游 hang 住不返首字节」会让 `fetch` 永远 pending，既不抛错也不返回，fallback 永不触发，整个请求挂死到客户端超时。

**目标**：给上游 `fetch` 加首字节超时（AbortController），超时按网络错处理 → 触发 fallback。让 B00 的容错覆盖上游 hang 这一最常见生产故障。

**方案**

新增 `fetchWithTimeout(url, init, timeoutMs, signal)`（`src/handlers.ts`）：

- 内部建 `AbortController`，`setTimeout(timeoutMs)` 后 `abort`
- 超时抛出的 `AbortError` 在 `handleMessages` 候选链里当 network 错（已有 catch 分支），自然走 fallback
- 透传客户端请求的 `signal`（客户端断连时级联 abort 上游，释放资源）
- 默认 `timeoutMs`：30s（覆盖 Anthropic streaming 首字节延迟）；env `CCC_UPSTREAM_TIMEOUT_MS` 可调

> 超时是「首字节 / 建连」超时，不是「总响应时长」——SSE 开始流式透传后就不管了（流式期间的长输出由 `idleTimeout: 255` 兜底）。

**改动点**

- `src/handlers.ts`：新增 `fetchWithTimeout`；`handleMessages` 把 `fetchImpl(...)` 换成 `fetchWithTimeout(...)`；从 `config` 读 `upstreamTimeoutMs`
- `src/config.ts`：`AppConfig` 加 `upstreamTimeoutMs: number`；`loadConfig` 读 `env.CCC_UPSTREAM_TIMEOUT_MS ?? 30000`
- `test/handlers.test.ts`：timeout 触发 fallback 用例（mock 第一调用挂住，`fetchWithTimeout` 超时后第二候选 200）；注入短 timeoutMs 避免测试真等 30s
- `README.md` / `CLAUDE.md`：移除「fetch 无超时」已知限制，改为超时行为说明

**收益**：fallback 覆盖上游 hang；客户端断连级联释放上游连接。

**风险**：timeoutMs 设太短会误杀正常推理（首字节前的 thinking）；设太长起不到保护作用。30s 是经验值，需按真实 provider 首字节延迟 P99 校准。

**依赖**：B00（在其候选链 catch 分支基础上接超时）