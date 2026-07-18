// handlers — 端点处理函数：model 路由、重写、注入 secret、SSE 透传、fallback
// 1:1 移植自 ccc-router Worker 的 handleMessages，扩展了上游 fallback 链。

import { CORS_HEADERS } from "./auth";
import { normalizeModel, type AppConfig, type Upstream } from "./config";

// 单个候选上游的失败记录（用于聚合 502 / config_error）
export interface CandidateError {
  baseUrl: string;
  reason: "secret_missing" | "network" | "http";
  status?: number;
  message: string;
}

export function jsonResponse(
  status: number,
  body: unknown,
  extra: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

// 列出所有上游真实可用的 model ID（upstreamId 去重）。
// Claude Code startup 会调这个端点做模型校验。
// fallback 候选不暴露——它是网关内部容错机制，client 只发主 alias。
export function listModels(routes: Record<string, Upstream>): Response {
  const seen = new Set<string>();
  const data: { id: string; type: string; display_name: string }[] = [];
  for (const up of Object.values(routes)) {
    if (seen.has(up.upstreamId)) continue;
    seen.add(up.upstreamId);
    data.push({ id: up.upstreamId, type: "model", display_name: up.upstreamId });
  }
  return jsonResponse(200, { data });
}

export function notFound(path: string): Response {
  return jsonResponse(404, {
    error: { type: "not_found", message: `path not found: ${path}` },
  });
}

export function badRequest(reason: string, supported: string[]): Response {
  return jsonResponse(400, {
    error: {
      type: "invalid_request_error",
      message: reason,
      supported_models: supported,
    },
  });
}

export function health(routes: Record<string, Upstream>): Response {
  return jsonResponse(200, {
    ok: true,
    name: "ai-gw",
    supported_models: Object.keys(routes),
  });
}

// 透传上游响应：复制 SSE 友好的 header + body（含流式 stream）。
export function passthroughResponse(upstreamResp: Response): Response {
  const respHeaders = new Headers();
  const ct = upstreamResp.headers.get("content-type");
  if (ct) respHeaders.set("Content-Type", ct);
  respHeaders.set("Cache-Control", "no-cache");
  for (const k of [
    "request-id",
    "anthropic-organization-id",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
    "retry-after",
  ]) {
    const v = upstreamResp.headers.get(k);
    if (v) respHeaders.set(k, v);
  }
  for (const [k, v] of Object.entries(CORS_HEADERS)) respHeaders.set(k, v);
  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}

// 触发 fallback 的 status：5xx 服务端错误、429 限流、529 过载。
// 4xx（含 401/403）不 fallback——客户端错误转嫁到备用 provider 也不会通。
export function shouldFallback(status: number): boolean {
  return status >= 500 || status === 429 || status === 529;
}

// 所有候选都失败时的聚合 502。
// 只向客户端暴露 sanitized 信息（index + reason + status），不泄露 baseUrl /
// 网络异常文本 / upstream 响应正文——完整错误仅供服务端日志。
export function aggregate502(errors: CandidateError[]): Response {
  return jsonResponse(502, {
    error: {
      type: "all_upstreams_failed",
      message: `all ${errors.length} upstream candidate(s) failed`,
      candidates: errors.map((e, i) => ({
        index: i,
        reason: e.reason,
        ...(e.status !== undefined ? { status: e.status } : {}),
      })),
    },
  });
}

// 主路由处理：认证由上层 routeRequest 完成，这里假定已通过。
// fetchImpl 默认全局 fetch；测试可注入 mock。
export async function handleMessages(
  request: Request,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  // 1. 读 body（一次 stream，存下来）
  const rawBody = await request.text();

  // 2. 解析 body（一次 parse；后续 fallback 候选重写 model 复用此对象）
  let originalBody: Record<string, unknown>;
  try {
    originalBody = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, {
      error: {
        type: "invalid_request_error",
        message: "request body is not valid JSON",
      },
    });
  }

  const model = originalBody.model;
  if (typeof model !== "string") {
    return badRequest("missing `model` in request body", Object.keys(config.routes));
  }

  // 3. 路由表匹配（normalize 后查表）
  const primary = config.routes[normalizeModel(model)];
  if (!primary) {
    return badRequest(`unsupported model: ${model}`, Object.keys(config.routes));
  }

  // 4. 候选链：主上游 + 其 fallbacks。multi=false 时行为与单上游完全一致。
  const candidates: Upstream[] = [primary, ...(primary.fallbacks ?? [])];
  const multi = candidates.length > 1;
  const errors: CandidateError[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];

    // 4.1 强制 BYOK：只用配置的 secret，不接受 client 端 token。缺失则跳过该候选。
    const apiKey = config.secrets[cand.secretKey];
    if (!apiKey) {
      errors.push({
        baseUrl: cand.baseUrl,
        reason: "secret_missing",
        message: `no token configured: ${cand.secretKey}`,
      });
      continue;
    }

    // 4.2 per-candidate model 重写：按该候选的 upstreamId（支持跨 provider 链）
    const bodyToSend =
      model === cand.upstreamId
        ? rawBody
        : JSON.stringify({ ...originalBody, model: cand.upstreamId });

    // 4.3 构造 upstream 请求头
    const upstreamHeaders = new Headers();
    upstreamHeaders.set("Content-Type", "application/json");
    upstreamHeaders.set("x-api-key", apiKey);
    upstreamHeaders.set(
      "anthropic-version",
      request.headers.get("anthropic-version") || "2023-06-01"
    );
    const beta = request.headers.get("anthropic-beta");
    if (beta) upstreamHeaders.set("anthropic-beta", beta);

    // 4.4 转发
    let upstreamResp: Response;
    try {
      upstreamResp = await fetchImpl(`${cand.baseUrl}/v1/messages`, {
        method: "POST",
        headers: upstreamHeaders,
        body: bodyToSend,
      });
    } catch (err) {
      errors.push({
        baseUrl: cand.baseUrl,
        reason: "network",
        message: `fetch failed: ${(err as Error).message}`,
      });
      continue;
    }

    // 4.5 判定是否需要 fallback（只看 status，不读 body——SSE 透传边界）
    if (!shouldFallback(upstreamResp.status)) {
      // 2xx 成功 或 4xx 客户端错误（不转嫁）→ 透传
      return passthroughResponse(upstreamResp);
    }
    if (!multi) {
      // 单候选（未配 fallback）：透传原始错误响应（与单上游现状一致）
      return passthroughResponse(upstreamResp);
    }

    // 多候选：取消 body 流（不读可能很大的错误正文）+ 记录失败，继续下一个候选
    await upstreamResp.body?.cancel().catch(() => undefined);
    errors.push({
      baseUrl: cand.baseUrl,
      reason: "http",
      status: upstreamResp.status,
      message: `upstream returned HTTP ${upstreamResp.status}`,
    });
  }

  // 5. 所有候选都失败：
  //    - 全是 secret 缺失（配置错误）→ 500 config_error
  //    - 否则（含网络错 / 5xx）→ 聚合 502
  if (errors.every((e) => e.reason === "secret_missing")) {
    return jsonResponse(500, {
      error: {
        type: "config_error",
        message: "no token available for any upstream candidate",
      },
    });
  }
  return aggregate502(errors);
}
