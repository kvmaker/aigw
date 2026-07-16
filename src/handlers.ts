// handlers — 端点处理函数：model 路由、重写、注入 secret、SSE 透传
// 1:1 移植自 ccc-router Worker 的 handleMessages。

import { CORS_HEADERS } from "./auth";
import { normalizeModel, type AppConfig, type Upstream } from "./config";

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

// 主路由处理：认证由上层 routeRequest 完成，这里假定已通过。
// fetchImpl 默认全局 fetch；测试可注入 mock。
export async function handleMessages(
  request: Request,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  // 1. 读 body（一次 stream，存下来）
  const rawBody = await request.text();

  // 2. 解析 model 字段
  let body: { model?: string };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, {
      error: {
        type: "invalid_request_error",
        message: "request body is not valid JSON",
      },
    });
  }
  const model = body?.model;
  if (!model) {
    return badRequest("missing `model` in request body", Object.keys(config.routes));
  }

  // 3. 路由表匹配（normalize 后查表）
  const upstream = config.routes[normalizeModel(model)];
  if (!upstream) {
    return badRequest(`unsupported model: ${model}`, Object.keys(config.routes));
  }

  // 4. 强制 BYOK：只用配置的 secret，不接受 client 端 token
  const apiKey = config.secrets[upstream.secretKey];
  if (!apiKey) {
    return jsonResponse(500, {
      error: {
        type: "config_error",
        message: `no token available for upstream ${upstream.baseUrl}`,
      },
    });
  }

  // 5. 重写 body.model 为上游真实 ID（upstreamId）。
  //    仅当原始 model 与 upstreamId 不同时重写。
  let bodyToSend = rawBody;
  if (model !== upstream.upstreamId) {
    try {
      const parsed = JSON.parse(rawBody);
      parsed.model = upstream.upstreamId;
      bodyToSend = JSON.stringify(parsed);
    } catch {
      bodyToSend = rawBody;
    }
  }

  // 6. 构造 upstream 请求
  const upstreamUrl = `${upstream.baseUrl}/v1/messages`;
  const upstreamHeaders = new Headers();
  upstreamHeaders.set("Content-Type", "application/json");
  upstreamHeaders.set("x-api-key", apiKey);
  upstreamHeaders.set(
    "anthropic-version",
    request.headers.get("anthropic-version") || "2023-06-01"
  );
  const beta = request.headers.get("anthropic-beta");
  if (beta) upstreamHeaders.set("anthropic-beta", beta);

  // 7. 转发
  let upstreamResp: Response;
  try {
    upstreamResp = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: bodyToSend,
    });
  } catch (err) {
    return jsonResponse(502, {
      error: {
        type: "upstream_error",
        message: `failed to reach upstream ${upstream.baseUrl}: ${(err as Error).message}`,
      },
    });
  }

  // 8. 透传响应（包含 SSE 流式）
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
