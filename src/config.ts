// config — 路由表、env 加载、model 规范化
// 路由表 1:1 对应原 ccc-router Worker。

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export interface Upstream {
  baseUrl: string;
  /** env 里对应的 secret 名字 */
  secretKey: string;
  /** 发给上游的 model 名（上游真实 ID）。
   *  client 可能发别名（如 GLM-5.2[1m]），但 GLM 上游只认 GLM-5.2；
   *  minimax 上游认 MiniMax-M3[1m]。转发前会把 body.model 重写为这个值。 */
  upstreamId: string;
  /** 备选上游链：主上游失败（网络错 / 5xx / 429 / 529）时按序尝试。
   *  每个 candidate 独立重写 model、注入自己的 secret。缺省无 fallback。
   *  仅挂在路由命中的主 Upstream 上；同一 Upstream 的多个 alias 共享同一条链。 */
  fallbacks?: Upstream[];
}

export interface AppConfig {
  routerToken: string;
  routes: Record<string, Upstream>;
  secrets: Record<string, string | undefined>;
  port: number;
  host: string;
}

// 把 "[1m]" 后缀剥掉后做小写匹配。
// client 发 "MiniMax-M3[1m]" / "GLM-5.2[1m]"，路由匹配用 normalize 后的 key。
export function normalizeModel(s: string): string {
  return s.toLowerCase().replace(/\[1m\]$/, "");
}

// 内置默认路由表（1:1 对应 Worker ROUTE_TABLE）
export const DEFAULT_ROUTES: Record<string, Upstream> = {
  "minimax-m3[1m]": {
    baseUrl: "https://api.minimaxi.com/anthropic",
    secretKey: "CCC_MINIMAX_AUTH_TOKEN",
    upstreamId: "MiniMax-M3[1m]",
  },
  "minimax-m3": {
    baseUrl: "https://api.minimaxi.com/anthropic",
    secretKey: "CCC_MINIMAX_AUTH_TOKEN",
    upstreamId: "MiniMax-M3[1m]",
  },
  "minimax-m2.7-highspeed": {
    baseUrl: "https://api.minimaxi.com/anthropic",
    secretKey: "CCC_MINIMAX_AUTH_TOKEN",
    upstreamId: "MiniMax-M2.7-highspeed",
  },
  "glm-5.2[1m]": {
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    secretKey: "CCC_GLM_AUTH_TOKEN",
    upstreamId: "GLM-5.2",
  },
  "glm-5.2": {
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    secretKey: "CCC_GLM_AUTH_TOKEN",
    upstreamId: "GLM-5.2",
  },
  // 火山方舟「Agent Plan」套餐专属 Anthropic 兼容端点（/api/plan）。
  // 该 key 为 plan 专属，在标准端点 /api/v3/anthropic 上反而不被接受（401）。
  // handlers 会拼 /v1/messages → https://ark.cn-beijing.volces.com/api/plan/v1/messages
  "kimi-k3[1m]": {
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
    secretKey: "CCC_ARK_AUTH_TOKEN",
    upstreamId: "kimi-k3",
  },
  "kimi-k3": {
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
    secretKey: "CCC_ARK_AUTH_TOKEN",
    upstreamId: "kimi-k3",
  },
};

// CCC_ROUTES env 条目结构（env 层用 secret 字段名，与上游 JSON 兼容）
interface FallbackEntry {
  baseUrl: string;
  secret: string;
  upstreamId: string;
}

interface RouteEntry {
  aliases: string[];
  baseUrl: string;
  secret: string;
  upstreamId: string;
  /** 备选上游链（env 层）；加载时递归映射为内部 Upstream.fallbacks */
  fallbacks?: FallbackEntry[];
}

// 把 env 层条目映射为内部 Upstream：secret → secretKey。
// 单层 fallback：fallback 候选不再支持嵌套 fallbacks（避免循环引用 / 过度工程），
// 即便 JSON 里写了也会被忽略——handlers 只展平一层候选链。
function toUpstream(e: {
  baseUrl: string;
  secret: string;
  upstreamId: string;
  fallbacks?: FallbackEntry[];
}): Upstream {
  return {
    baseUrl: e.baseUrl,
    secretKey: e.secret,
    upstreamId: e.upstreamId,
    fallbacks: e.fallbacks?.map((f) => ({
      baseUrl: f.baseUrl,
      secretKey: f.secret,
      upstreamId: f.upstreamId,
    })),
  };
}

// 解析 CCC_ROUTES（JSON 数组）为路由表；undefined 返回空对象。
export function loadRoutesFromEnv(
  envValue: string | undefined
): Record<string, Upstream> {
  if (!envValue) return {};
  const entries: RouteEntry[] = JSON.parse(envValue);
  const routes: Record<string, Upstream> = {};
  for (const e of entries) {
    const up = toUpstream(e);
    for (const alias of e.aliases) {
      routes[normalizeModel(alias)] = up;
    }
  }
  return routes;
}

// 配置错误（YAML schema 校验失败 / 文件读失败 / 解析失败）。
// fail-fast：loadConfig 抛出后进程拒绝启动，避免带病运行。
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ---- YAML 配置层 ----
// YAML entry 用 secretKey（对齐内部 Upstream），与 env JSON 层的 secret 字段区分。
// 顶层支持两种形态：直接数组 [...entries]，或 { routes: [...] }。
interface YamlUpstreamRaw {
  baseUrl: string;
  secretKey: string;
  upstreamId: string;
}

interface YamlRouteEntryRaw {
  aliases: string[];
  upstream: YamlUpstreamRaw;
  fallbacks?: YamlUpstreamRaw[];
}

// 校验单个 upstream 节点（主 / fallback 共用）。非法即抛 ConfigError。
function validateUpstream(u: unknown, ctx: string): YamlUpstreamRaw {
  if (typeof u !== "object" || u === null) {
    throw new ConfigError(`${ctx}: must be an object`);
  }
  const obj = u as Record<string, unknown>;
  const { baseUrl, secretKey, upstreamId } = obj;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new ConfigError(`${ctx}: baseUrl must be a non-empty string`);
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError(`${ctx}: baseUrl must be a valid URL, got: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${ctx}: baseUrl must be http/https, got: ${url.protocol}`);
  }
  if (typeof secretKey !== "string" || secretKey.length === 0) {
    throw new ConfigError(`${ctx}: secretKey must be a non-empty string`);
  }
  if (typeof upstreamId !== "string" || upstreamId.length === 0) {
    throw new ConfigError(`${ctx}: upstreamId must be a non-empty string`);
  }
  return { baseUrl, secretKey, upstreamId };
}

// 校验一条路由 entry。非法即抛 ConfigError。
function validateRouteEntry(entry: unknown, index: number): YamlRouteEntryRaw {
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
  const upstream = validateUpstream(obj.upstream, `${ctx}.upstream`);
  let fallbacks: YamlUpstreamRaw[] | undefined;
  if (obj.fallbacks !== undefined) {
    if (!Array.isArray(obj.fallbacks)) {
      throw new ConfigError(`${ctx}.fallbacks: must be an array`);
    }
    fallbacks = obj.fallbacks.map((f, fi) =>
      validateUpstream(f, `${ctx}.fallbacks[${fi}]`)
    );
  }
  return { aliases, upstream, fallbacks };
}

// 解析 YAML 字符串为路由表。纯函数（无 fs），便于单测。
// 顶层形态：直接数组 或 { routes: [...] }。
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
  let entries: unknown[];
  if (Array.isArray(doc)) {
    entries = doc;
  } else if (
    typeof doc === "object" &&
    doc !== null &&
    Array.isArray((doc as Record<string, unknown>).routes)
  ) {
    entries = (doc as { routes: unknown[] }).routes;
  } else {
    throw new ConfigError("YAML root must be an array or { routes: [...] }");
  }

  const routes: Record<string, Upstream> = {};
  for (const [index, entry] of entries.entries()) {
    const valid = validateRouteEntry(entry, index);
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

// 读 CCC_CONFIG_FILE 指向的 YAML 文件并解析。文件缺失 / 不可读 → ConfigError。
function loadRoutesFromYamlFile(filePath: string): Record<string, Upstream> {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new ConfigError(
      `cannot read CCC_CONFIG_FILE (${filePath}): ${(err as Error).message}`
    );
  }
  return loadRoutesFromYaml(content);
}

// 从 env 聚合所有运行时配置。默认参数 process.env，测试可传 mock env。
// 路由表优先级（后者覆盖前者）：
//   DEFAULT_ROUTES（内置兜底） < CCC_CONFIG_FILE(YAML) < CCC_ROUTES(env JSON，最高)
export function loadConfig(
  env: Record<string, string | undefined> = process.env
): AppConfig {
  // 路由表三层合并：内置兜底 → YAML 文件 → env JSON（最高优先，便于临时覆盖）。
  // CCC_CONFIG_FILE 缺省时不启用 YAML，行为与旧版一致。
  let routes: Record<string, Upstream> = { ...DEFAULT_ROUTES };
  if (env.CCC_CONFIG_FILE) {
    routes = { ...routes, ...loadRoutesFromYamlFile(env.CCC_CONFIG_FILE) };
  }
  routes = { ...routes, ...loadRoutesFromEnv(env.CCC_ROUTES) };

  return {
    routerToken: env.CCC_ROUTER_TOKEN ?? "",
    routes,
    secrets: {
      CCC_MINIMAX_AUTH_TOKEN: env.CCC_MINIMAX_AUTH_TOKEN,
      CCC_GLM_AUTH_TOKEN: env.CCC_GLM_AUTH_TOKEN,
      CCC_ARK_AUTH_TOKEN: env.CCC_ARK_AUTH_TOKEN,
    },
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "127.0.0.1",
  };
}
