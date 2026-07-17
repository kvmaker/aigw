// ai-gw 入口 — routeRequest 路由分发 + Bun.serve 启动
// routeRequest 是纯函数（不依赖真实 server），便于测试。
// Bun.serve 仅在文件作为入口运行时启动（import.meta.main）。

import { CORS_HEADERS, verifyBearer } from "./auth";
import { loadConfig, type AppConfig } from "./config";
import {
  handleMessages,
  health,
  jsonResponse,
  listModels,
  notFound,
} from "./handlers";

export async function routeRequest(
  request: Request,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const url = new URL(request.url);

  // CORS 预检
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // /v1/models — Claude Code startup 校验用
  if (url.pathname === "/v1/models") {
    if (request.method !== "GET") {
      return jsonResponse(405, { error: { type: "method_not_allowed" } });
    }
    const authErr = verifyBearer(request, config.routerToken);
    if (authErr) return authErr;
    return listModels(config.routes);
  }

  // /v1/messages — 主路由
  if (url.pathname === "/v1/messages") {
    if (request.method !== "POST") {
      return jsonResponse(405, { error: { type: "method_not_allowed" } });
    }
    const authErr = verifyBearer(request, config.routerToken);
    if (authErr) return authErr;
    return handleMessages(request, config, fetchImpl);
  }

  // / — 健康检查
  if (url.pathname === "/") {
    return health(config.routes);
  }

  return notFound(url.pathname);
}

// 仅当直接运行时启动 HTTP server（测试 import 时不启动）
if (import.meta.main) {
  const config = loadConfig();
  Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch: (req) => routeRequest(req, config),
  });
  console.log(
    `ai-gw listening on http://${config.host}:${config.port} ` +
      `(models: ${Object.keys(config.routes).length} keys)`
  );
}
