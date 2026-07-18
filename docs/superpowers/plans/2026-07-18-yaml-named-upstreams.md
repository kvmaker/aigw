# YAML 命名上游 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 YAML 路由配置支持顶层 `upstreams:` 命名定义 + 字符串引用，消除 fallback 里 `baseUrl`/`secretKey`/`upstreamId` 三元组重复。

**Architecture:** 纯解析层改造。`loadRoutesFromYaml` 先把顶层 `upstreams:` 收成 `Map<name, 三元组>`，再在解析每条 route 时把 `upstream` / `fallbacks[]` 的字符串引用解引用成完整三元组。展开后产出的内部 `Upstream` 与今天逐字节相同，`handlers.ts` 运行时零改动。

**Tech Stack:** TypeScript + Bun 运行时，`bun:test` 测试框架，`yaml`（eemeyer/yaml）解析库。

## Global Constraints

- TypeScript，Bun 运行时；测试用 `bun:test`，全部 mock，不依赖真实 token。
- **`src/handlers.ts` 运行时零改动**：内部 `Upstream` 结构（`baseUrl` + `secretKey` + `upstreamId` + 可选 `fallbacks`）不变。
- env JSON 层（`loadRoutesFromEnv` / `CCC_ROUTES`）不动；`DEFAULT_ROUTES` 不动。
- 旧的内联 YAML（无 `upstreams:` 块、route 里写对象）必须向后兼容，现有 81 个用例不回归。
- `secretKey` 写的是 `.env` 里的变量名，真实 token 绝不入 YAML。
- 所有 schema 错误 fail-fast：抛 `ConfigError`，进程拒绝启动。
- `yaml` 库默认对 mapping 重复 key 抛 `Map keys must be unique`，被 `loadRoutesFromYaml` 的 catch 转成 `ConfigError("YAML parse failed: ...")` —— **重名检测由 parser 自动兜底，无需专门代码**。
- 改路由表后必跑 `bun test`（若 `bun` 不在 PATH，用 `~/.bun/bin/bun test`）。
- 提交信息中文，格式 `<类型>: <描述>`，末尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`。

**Spec 偏差说明**：spec 第「解析与校验」第 2 条写「名字重复 → ConfigError(`upstreams.<name>: duplicate definition`)」。实测 `yaml` 库默认就在 parser 层抛 `Map keys must be unique`，落在 `loadRoutesFromYaml` 现有的 `catch (err)` 里转成 `ConfigError("YAML parse failed: ...")`。因此**不新增专门的重名检测代码**，行为等价（fail-fast 拒绝启动），仅错误文案不同。测试断言用 `/unique/i`。

---

## File Structure

| 文件 | 职责 | 本次 |
|---|---|---|
| `src/config.ts` | 路由表、YAML/env 加载、`normalizeModel`、schema 校验 | **改造**：`loadRoutesFromYaml` + 新增 2 个 helper |
| `src/handlers.ts` | 端点处理、SSE 透传、fallback 候选链 | **不动** |
| `test/config.test.ts` | config 层单测（normalize / env / yaml / loadConfig） | **新增用例** |
| `ai-gw.example.yaml` | YAML 配置示例 | **重写**为命名上游格式 |
| `README.md` | 项目文档 | 更新 YAML 章节 |
| `CLAUDE.md` | 项目指令 / Gotchas | 更新 Gotcha 第 7 条 |

`src/config.ts` 内部本次新增的两个 helper（不导出，仅供 `loadRoutesFromYaml` 用）：

- `parseNamedUpstreams(raw: unknown): Map<string, YamlUpstreamRaw>` —— 解析顶层 `upstreams:`，每个值复用 `validateUpstream` 校验。
- `resolveUpstreamRef(node: unknown, ctx: string, named): YamlUpstreamRaw` —— string → 查 map（查不到抛 `ConfigError`）；object → 复用 `validateUpstream`。

`validateRouteEntry` 加一个 `named` 参数；`upstream` 与每个 fallback 元素都改走 `resolveUpstreamRef`。

---

## Task 1: 命名上游解析 + 字符串引用（核心）

**Files:**
- Modify: `src/config.ts`（`loadRoutesFromYaml` 及其依赖的 helper、`validateRouteEntry`）
- Test: `test/config.test.ts`（新增 `describe("loadRoutesFromYaml 命名上游")` 块）

**Interfaces:**
- Consumes: 现有 `validateUpstream(u, ctx)`、`normalizeModel`、`YamlUpstreamRaw`、`ConfigError`、`parseYaml` —— 签名均不变。
- Produces: `loadRoutesFromYaml` 行为扩展（仍返回 `Record<string, Upstream>`，内部结构不变）；下游 `loadConfig` / `handlers.ts` 零感知。

- [ ] **Step 1: 写失败测试**

在 `test/config.test.ts` 的 `describe("loadRoutesFromYaml", () => { ... })` 块**末尾**（第 333 行 `});` 之前）追加这组用例：

```typescript
  // ---- 命名上游 + 字符串引用 ----
  test("upstreams 块 + route 用字符串引用（主 + fallback）", () => {
    const routes = loadRoutesFromYaml(`
upstreams:
  glm:
    baseUrl: https://glm.example.com
    secretKey: CCC_GLM
    upstreamId: GLM-5.2
  ark:
    baseUrl: https://ark.example.com
    secretKey: CCC_ARK
    upstreamId: kimi-k3
routes:
  - aliases: ["glm-5.2"]
    upstream: glm
  - aliases: ["kimi-k3"]
    upstream: ark
    fallbacks: [glm]
`);
    expect(routes["glm-5.2"]).toBeDefined();
    expect(routes["glm-5.2"].baseUrl).toBe("https://glm.example.com");
    expect(routes["glm-5.2"].secretKey).toBe("CCC_GLM");
    expect(routes["glm-5.2"].upstreamId).toBe("GLM-5.2");
    expect(routes["glm-5.2"].fallbacks).toBeUndefined();

    const kimi = routes["kimi-k3"];
    expect(kimi.baseUrl).toBe("https://ark.example.com");
    expect(kimi.fallbacks).toHaveLength(1);
    expect(kimi.fallbacks![0].baseUrl).toBe("https://glm.example.com");
    expect(kimi.fallbacks![0].secretKey).toBe("CCC_GLM");
    expect(kimi.fallbacks![0].upstreamId).toBe("GLM-5.2");
    expect(kimi.fallbacks![0].fallbacks).toBeUndefined();
  });

  test("引用不存在的上游名 → ConfigError（upstream 位置）", () => {
    expect(() =>
      loadRoutesFromYaml(`
routes:
  - aliases: ["x"]
    upstream: nope
`)
    ).toThrow(/unknown upstream reference "nope"/);
  });

  test("引用不存在的上游名 → ConfigError（fallbacks 位置）", () => {
    expect(() =>
      loadRoutesFromYaml(`
upstreams:
  glm:
    baseUrl: https://glm.example.com
    secretKey: CCC_GLM
    upstreamId: GLM-5.2
routes:
  - aliases: ["x"]
    upstream: glm
    fallbacks: [missing]
`)
    ).toThrow(/unknown upstream reference "missing"/);
  });

  test("upstreams 同名 key → ConfigError（parser 兜底）", () => {
    expect(() =>
      loadRoutesFromYaml(`
upstreams:
  glm:
    baseUrl: https://a.example.com
    secretKey: CCC_A
    upstreamId: A
  glm:
    baseUrl: https://b.example.com
    secretKey: CCC_B
    upstreamId: B
routes:
  - aliases: ["x"]
    upstream: glm
`)
    ).toThrow(/unique/i);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `~/.bun/bin/bun test test/config.test.ts`（若 `bun` 在 PATH，用 `bun test test/config.test.ts`）

Expected: 4 个新用例失败。第 1 个失败信息类似 `expected ... to be defined` 或 `unknown upstream reference` 未抛出（因为当前 `upstream: glm` 是字符串会被 `validateUpstream` 当非法对象拒绝）；后 3 个失败因为行为未实现或抛错文案不符。现有用例仍全绿。

- [ ] **Step 3: 实现 parseNamedUpstreams + resolveUpstreamRef**

在 `src/config.ts` 中，`validateRouteEntry` 函数**之前**（约第 182 行 `// 校验一条路由 entry` 注释上方）插入两个 helper：

```typescript
// 命名上游表：顶层 upstreams: 块的解析产物，name → 三元组。
// route 的 upstream / fallbacks 元素若用字符串引用，就到这里查。
type NamedUpstreams = Map<string, YamlUpstreamRaw>;

// 解析顶层 upstreams: map（可选）。每个值复用 validateUpstream 校验。
// 重名由 yaml parser 在 parse 阶段抛 Map keys must be unique 兜底，无需在此检测。
function parseNamedUpstreams(raw: unknown): NamedUpstreams {
  const map: NamedUpstreams = new Map();
  if (raw === undefined) return map;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("upstreams: must be a mapping");
  }
  for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
    map.set(name, validateUpstream(val, `upstreams.${name}`));
  }
  return map;
}

// 把 upstream / fallback 元素解析为三元组。
// string → 在 named map 里查，查不到 fail-fast；object → 复用 validateUpstream（内联，向后兼容）。
function resolveUpstreamRef(
  node: unknown,
  ctx: string,
  named: NamedUpstreams
): YamlUpstreamRaw {
  if (typeof node === "string") {
    const found = named.get(node);
    if (!found) {
      throw new ConfigError(`${ctx}: unknown upstream reference "${node}"`);
    }
    return found;
  }
  return validateUpstream(node, ctx);
}
```

- [ ] **Step 4: 改造 validateRouteEntry 接收 named**

把 `src/config.ts` 现有 `validateRouteEntry` 整体替换为（签名加 `named`，`upstream` 与 fallbacks 元素改走 `resolveUpstreamRef`）：

```typescript
// 校验一条路由 entry。非法即抛 ConfigError。
// upstream / fallbacks 元素支持字符串引用（查 named）或内联对象（向后兼容）。
function validateRouteEntry(
  entry: unknown,
  index: number,
  named: NamedUpstreams
): YamlRouteEntryRaw {
  const ctx = `routes[${index}]`;
  if (typeof entry !== "object" || entry === null) {
    throw new ConfigError(`${ctx}: must be an object`);
  }
  const obj = entry as Record<string, unknown>;
  const aliases = obj.aliases;
  if (!Array.isArray(aliases) || aliases.length === 0) {
    throw new ConfigError(`${ctx}: aliases must be a non-empty array`);
  }
  for (const [i, a] of aliases.entries()) {
    if (typeof a !== "string" || a.length === 0) {
      throw new ConfigError(`${ctx}.aliases[${i}]: must be a non-empty string`);
    }
  }
  const upstream = resolveUpstreamRef(obj.upstream, `${ctx}.upstream`, named);
  let fallbacks: YamlUpstreamRaw[] | undefined;
  if (obj.fallbacks !== undefined) {
    if (!Array.isArray(obj.fallbacks)) {
      throw new ConfigError(`${ctx}.fallbacks: must be an array`);
    }
    fallbacks = obj.fallbacks.map((f, fi) =>
      resolveUpstreamRef(f, `${ctx}.fallbacks[${fi}]`, named)
    );
  }
  return { aliases, upstream, fallbacks };
}
```

- [ ] **Step 5: 改造 loadRoutesFromYaml 解析顶层 upstreams 并透传 named**

把 `src/config.ts` 现有 `loadRoutesFromYaml` 整体替换为：

```typescript
// 解析 YAML 字符串为路由表。纯函数（无 fs），便于单测。
// 顶层形态：直接数组、{ routes: [...] }、{ upstreams: {...}, routes: [...] } 均可。
// route 的 upstream / fallbacks 元素支持字符串引用（命名上游）或内联对象（向后兼容）。
export function loadRoutesFromYaml(content: string): Record<string, Upstream> {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch (err) {
    throw new ConfigError(`YAML parse failed: ${(err as Error).message}`);
  }
  if (doc === null || doc === undefined) {
    throw new ConfigError("YAML is empty");
  }

  let named: NamedUpstreams;
  let entries: unknown[];
  if (Array.isArray(doc)) {
    // 顶层直接是数组：无 upstreams 块，route 必须用内联对象。
    named = new Map();
    entries = doc;
  } else if (typeof doc === "object" && doc !== null) {
    const obj = doc as Record<string, unknown>;
    if (!Array.isArray(obj.routes)) {
      throw new ConfigError("YAML root must be an array or { routes: [...] }");
    }
    named = parseNamedUpstreams(obj.upstreams);
    entries = obj.routes;
  } else {
    throw new ConfigError("YAML root must be an array or { routes: [...] }");
  }

  if (entries.length === 0) {
    throw new ConfigError("YAML routes must contain at least one entry");
  }

  const routes: Record<string, Upstream> = {};
  for (const [index, entry] of entries.entries()) {
    const valid = validateRouteEntry(entry, index, named);
    const fb = valid.fallbacks?.map((f) => ({
      baseUrl: f.baseUrl,
      secretKey: f.secretKey,
      upstreamId: f.upstreamId,
    }));
    const up: Upstream = {
      baseUrl: valid.upstream.baseUrl,
      secretKey: valid.upstream.secretKey,
      upstreamId: valid.upstream.upstreamId,
      ...(fb && fb.length > 0 ? { fallbacks: fb } : {}),
    };
    for (const alias of valid.aliases) {
      routes[normalizeModel(alias)] = up;
    }
  }
  return routes;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `~/.bun/bin/bun test test/config.test.ts`

Expected: 全绿，含 4 个新用例。现有用例（含「缺 upstream 抛 ConfigError」等）不回归 —— 注意旧用例「缺 upstream」走的 `validateUpstream(undefined, "routes[0].upstream")` 报错仍含 `upstream` 字样，匹配 `/upstream/` 不变。

- [ ] **Step 7: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "$(cat <<'EOF'
feat(config): YAML 命名上游，简化 fallback 配置

顶层新增可选 upstreams: 命名定义块，route 的 upstream / fallbacks 支持
字符串引用，消除 fallback 里 baseUrl/secretKey/upstreamId 三元组重复。
纯解析层改造，handlers.ts 运行时零改动，旧内联 YAML 向后兼容。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 边界锁定（混用 / 顶层形态 / upstreams 块校验）

**Files:**
- Test: `test/config.test.ts`（在「命名上游」用例组后追加）

**Interfaces:**
- Consumes: Task 1 的 `loadRoutesFromYaml` 新行为。
- Produces: 仅测试，无新接口。

这一批大多应直接通过（Task 1 已实现核心），目的是锁定「混用」与「`upstreams` 块内三元组校验」行为，防止后续回归。若某条意外失败，按报错补实现（预期不需要）。

- [ ] **Step 1: 写测试**

在 Task 1 新增的命名上游用例块末尾追加：

```typescript
  test("混用：upstream 用引用，fallbacks 内联对象", () => {
    const routes = loadRoutesFromYaml(`
upstreams:
  ark:
    baseUrl: https://ark.example.com
    secretKey: CCC_ARK
    upstreamId: kimi-k3
routes:
  - aliases: ["kimi-k3"]
    upstream: ark
    fallbacks:
      - baseUrl: https://glm.example.com
        secretKey: CCC_GLM
        upstreamId: GLM-5.2
`);
    expect(routes["kimi-k3"].baseUrl).toBe("https://ark.example.com");
    expect(routes["kimi-k3"].fallbacks![0].baseUrl).toBe("https://glm.example.com");
    expect(routes["kimi-k3"].fallbacks![0].upstreamId).toBe("GLM-5.2");
  });

  test("混用：upstream 内联对象，fallbacks 用引用", () => {
    const routes = loadRoutesFromYaml(`
upstreams:
  glm:
    baseUrl: https://glm.example.com
    secretKey: CCC_GLM
    upstreamId: GLM-5.2
routes:
  - aliases: ["kimi-k3"]
    upstream:
      baseUrl: https://ark.example.com
      secretKey: CCC_ARK
      upstreamId: kimi-k3
    fallbacks: [glm]
`);
    expect(routes["kimi-k3"].baseUrl).toBe("https://ark.example.com");
    expect(routes["kimi-k3"].fallbacks![0].upstreamId).toBe("GLM-5.2");
  });

  test("upstreams 块内三元组非法 → ConfigError（定位到 upstreams.<name>）", () => {
    expect(() =>
      loadRoutesFromYaml(`
upstreams:
  glm:
    baseUrl: ftp://nope.example.com
    secretKey: CCC_GLM
    upstreamId: GLM-5.2
routes:
  - aliases: ["x"]
    upstream: glm
`)
    ).toThrow(/upstreams\.glm.*http\/https|http\/https.*upstreams\.glm/s);
  });

  test("upstreams 非 mapping（数组）→ ConfigError", () => {
    expect(() =>
      loadRoutesFromYaml(`
upstreams: [1, 2, 3]
routes:
  - aliases: ["x"]
    upstream:
      baseUrl: https://x.example.com
      secretKey: CCC_X
      upstreamId: x
`)
    ).toThrow(/upstreams: must be a mapping/);
  });
```

- [ ] **Step 2: 跑测试**

Run: `~/.bun/bin/bun test test/config.test.ts`

Expected: 全绿。若「upstreams 块内三元组非法」正则不匹配，调整断言为 `.toThrow(ConfigError)` 并 `try/catch` 断言 `.message` 含 `upstreams.glm` 与 `http/https`（Task 1 的 `parseNamedUpstreams` 已用 `validateUpstream(val, "upstreams.glm")`，消息形如 `upstreams.glm: baseUrl must be http/https, got: ftp:`）。

- [ ] **Step 3: Commit**

```bash
git add test/config.test.ts
git commit -m "$(cat <<'EOF'
test(config): 锁定命名上游混用与 upstreams 块校验行为

补 4 个用例：引用/内联混用、upstreams 块内三元组非法、upstreams 非数组，
防止后续回归。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 文档更新（example + README + CLAUDE.md）

**Files:**
- Modify: `ai-gw.example.yaml`（整文件重写为命名上游格式）
- Modify: `README.md`（YAML 配置小节）
- Modify: `CLAUDE.md`（Gotcha 第 7 条）

**Interfaces:** 无（纯文档）。改完跑一次全量 `bun test` 确保未误改代码。

- [ ] **Step 1: 重写 ai-gw.example.yaml**

把 `ai-gw.example.yaml` 整文件替换为：

```yaml
# ai-gw 路由表示例（YAML）
#
# 启用方式：复制为 ai-gw.yaml 并按需修改，再用环境变量指向它：
#   CCC_CONFIG_FILE=/path/to/ai-gw.yaml
#
# 路由表优先级（后者覆盖前者）：
#   内置 DEFAULT_ROUTES  <  本 YAML 文件  <  CCC_ROUTES（env JSON，最高，便于临时覆盖）
#
# secretKey 写的是 .env 里的环境变量名，真实 token 绝不入 YAML、不入库。
# 顶层支持两种形态：本文件用的 { routes: [...] }，或直接写成数组。

# 命名上游：每个上游（baseUrl + secretKey + upstreamId）定义一次并命名，
# route 的 upstream / fallbacks 只需写名字，避免 fallback 里三元组重复。
upstreams:
  glm:
    baseUrl: https://open.bigmodel.cn/api/anthropic
    secretKey: CCC_GLM_AUTH_TOKEN
    upstreamId: GLM-5.2
  ark:
    baseUrl: https://ark.cn-beijing.volces.com/api/plan
    secretKey: CCC_ARK_AUTH_TOKEN
    upstreamId: kimi-k3
  minimax:
    baseUrl: https://api.minimaxi.com/anthropic
    secretKey: CCC_MINIMAX_AUTH_TOKEN
    upstreamId: MiniMax-M3[1m]

routes:
  # GLM-5.2 —— 主上游直接命中，无 fallback
  - aliases: ["glm-5.2", "glm-5.2[1m]"]
    upstream: glm

  # kimi-k3 —— 主走 ark「Agent Plan」专属端点 /api/plan；
  # 主上游失败（网络错 / 5xx / 429 / 529）时 fallback 到 GLM（跨 provider 链）
  - aliases: ["kimi-k3", "kimi-k3[1m]"]
    upstream: ark
    fallbacks: [glm]

  # MiniMax-M3 —— 主 + 备示例（按需启用）
  - aliases: ["minimax-m3", "minimax-m3[1m]"]
    upstream: minimax
    fallbacks: [glm]
```

- [ ] **Step 2: 更新 README.md 的 YAML 配置小节**

把 `README.md` 第 48–63 行（从 `YAML schema（与 ...）` 到 `真实 token 依旧只在 .env。`）替换为：

````markdown
YAML schema（与 [Fallback](#fallback上游容错) 数据结构对齐）。顶层可选 `upstreams:` 块给每个上游命名（`baseUrl` + `secretKey` + `upstreamId` 三元组定义一次），`routes` 里的 `upstream` 与 `fallbacks` 既能写命名引用，也能内联对象（向后兼容）：

```yaml
upstreams:
  glm:
    baseUrl: https://open.bigmodel.cn/api/anthropic
    secretKey: CCC_GLM_AUTH_TOKEN     # .env 里的变量名，不是真实 token
    upstreamId: GLM-5.2
  ark:
    baseUrl: https://ark.cn-beijing.volces.com/api/plan
    secretKey: CCC_ARK_AUTH_TOKEN
    upstreamId: kimi-k3

routes:
  - aliases: ["kimi-k3", "kimi-k3[1m]"]
    upstream: ark                      # 引用 upstreams.ark
    fallbacks: [glm]                   # 引用 upstreams.glm，三元组不再重复
```

加载时做 schema 校验（`aliases` 非空、`baseUrl` 合法 http(s) URL、`secretKey`/`upstreamId` 非空、`upstreams` 为 mapping），非法配置 fail-fast 拒绝启动；引用未定义的上游名也会 fail-fast。`secretKey` 写环境变量名，真实 token 依旧只在 `.env`。
````

（替换后保持第 38 行 `### YAML 配置（推荐）` 小节标题与上文不变。）

- [ ] **Step 3: 更新 CLAUDE.md Gotcha 第 7 条**

在 `CLAUDE.md` 的「关键 Gotchas」第 7 条末尾追加一句：

> 顶层可选 `upstreams:` 块给每个上游命名（三元组定义一次），route 的 `upstream` / `fallbacks` 支持字符串引用或内联对象（向后兼容）；引用未定义的名字 fail-fast。重名 key 由 yaml parser 直接报 `Map keys must be unique`。

- [ ] **Step 4: 跑全量测试确认未误改代码**

Run: `~/.bun/bin/bun test`

Expected: 全部通过（现有 81 + Task 1 的 4 + Task 2 的 4 = 89 个）。

- [ ] **Step 5: Commit**

```bash
git add ai-gw.example.yaml README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: example/README/CLAUDE.md 改用命名上游格式

ai-gw.example.yaml 重写为 upstreams: + 引用形式，GLM 三元组只出现一次；
README 与 CLAUDE.md Gotcha 第 7 条同步说明命名上游机制。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 验收（实施完成后整体检查）

- `ai-gw.example.yaml` 里 GLM 三元组只出现一次。
- `~/.bun/bin/bun test` 全绿（89 个用例），现有 81 个不回归。
- 旧的内联 YAML（无 `upstreams:`）仍能解析（现有用例作证）。
- 引用错误 / `upstreams` 块三元组非法 / 非 mapping 时，进程 fail-fast 拒绝启动，错误信息指明位置与引用名。
