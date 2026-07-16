// auth — Bearer 认证、constant-time 比较、CORS 头

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Constant-time string compare，避免 timing attack
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: { type: "unauthorized" } }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": "Bearer",
      ...CORS_HEADERS,
    },
  });
}

// 返回 null 表示通过；返回 Response 表示拒绝（直接 return 给 client）。
export function verifyBearer(
  request: Request,
  routerToken: string
): Response | null {
  if (!routerToken) {
    return new Response(
      JSON.stringify({
        error: { type: "config_error", message: "CCC_ROUTER_TOKEN not set" },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      }
    );
  }
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m || !timingSafeEqual(m[1], routerToken)) {
    return unauthorized();
  }
  return null;
}
