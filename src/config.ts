// config — 路由表、env 加载、model 规范化
// 路由表 1:1 对应原 ccc-router Worker。

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

// 从 env 聚合所有运行时配置。默认参数 process.env，测试可传 mock env。
export function loadConfig(
  env: Record<string, string | undefined> = process.env
): AppConfig {
  return {
    routerToken: env.CCC_ROUTER_TOKEN ?? "",
    routes: { ...DEFAULT_ROUTES, ...loadRoutesFromEnv(env.CCC_ROUTES) },
    secrets: {
      CCC_MINIMAX_AUTH_TOKEN: env.CCC_MINIMAX_AUTH_TOKEN,
      CCC_GLM_AUTH_TOKEN: env.CCC_GLM_AUTH_TOKEN,
      CCC_ARK_AUTH_TOKEN: env.CCC_ARK_AUTH_TOKEN,
    },
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "127.0.0.1",
  };
}
