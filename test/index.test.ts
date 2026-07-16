import { test, expect, describe } from "bun:test";
import { routeRequest } from "../src/index";
import { DEFAULT_ROUTES, type AppConfig } from "../src/config";

const config: AppConfig = {
  routerToken: "secret",
  routes: { ...DEFAULT_ROUTES },
  secrets: {
    CCC_MINIMAX_AUTH_TOKEN: "mm-token",
    CCC_GLM_AUTH_TOKEN: "glm-token",
  },
  port: 8787,
  host: "127.0.0.1",
};

const authHeader = { Authorization: "Bearer secret" };

describe("routeRequest", () => {
  test("OPTIONS → 204 + CORS", async () => {
    const res = await routeRequest(
      new Request("https://x/", { method: "OPTIONS" }),
      config
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("GET / → health（无需 auth）", async () => {
    const res = await routeRequest(new Request("https://x/"), config);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.name).toBe("ai-gw");
  });

  test("GET /v1/models 无 auth → 401", async () => {
    const res = await routeRequest(
      new Request("https://x/v1/models"),
      config
    );
    expect(res.status).toBe(401);
  });

  test("GET /v1/models 有 auth → 200 + 模型列表", async () => {
    const res = await routeRequest(
      new Request("https://x/v1/models", { headers: authHeader }),
      config
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string }[] };
    expect(json.data.length).toBeGreaterThan(0);
  });

  test("POST /v1/messages 有 auth + 合法 model → 200", async () => {
    const mockFetch = ((async () =>
      new Response("data: ok\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch);
    const res = await routeRequest(
      new Request("https://x/v1/messages", {
        method: "POST",
        headers: { ...authHeader, "content-type": "application/json" },
        body: JSON.stringify({ model: "GLM-5.2", messages: [] }),
      }),
      config,
      mockFetch
    );
    expect(res.status).toBe(200);
  });

  test("POST /v1/messages 无 auth → 401", async () => {
    const res = await routeRequest(
      new Request("https://x/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "GLM-5.2" }),
      }),
      config
    );
    expect(res.status).toBe(401);
  });

  test("未知路径 → 404", async () => {
    const res = await routeRequest(new Request("https://x/unknown"), config);
    expect(res.status).toBe(404);
  });

  test("GET /v1/messages（方法不允许）→ 405", async () => {
    const res = await routeRequest(
      new Request("https://x/v1/messages", { headers: authHeader }),
      config
    );
    expect(res.status).toBe(405);
  });
});
