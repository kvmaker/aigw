import { test, expect, describe } from "bun:test";
import {
  jsonResponse,
  listModels,
  notFound,
  badRequest,
  health,
  handleMessages,
} from "../src/handlers";
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

// 捕获 fetchImpl 收到的参数（含上游 header）
type Captured = {
  url: string;
  apiKey: string;
  body: string;
  anthropicVersion: string | null;
  anthropicBeta: string | null;
};

// 无参：原 captured 参数是 brief 残留脚手架，从未被读取（finding 3 清理）。
// 真正生效的是对外层 holder.v 的赋值。
function mockFetchOk() {
  return (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers as HeadersInit);
    holder.v = {
      url,
      apiKey: headers.get("x-api-key")!,
      body: init.body as string,
      anthropicVersion: headers.get("anthropic-version"),
      anthropicBeta: headers.get("anthropic-beta"),
    };
    return new Response("data: ok\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream", "request-id": "req-1" },
    });
  }) as typeof fetch;
}
const holder: { v: Captured | null } = { v: null };

describe("jsonResponse", () => {
  test("返回 JSON + CORS 头", async () => {
    const res = jsonResponse(200, { ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("listModels", () => {
  test("返回去重的 upstreamId 列表", async () => {
    const res = listModels(config.routes);
    const json = (await res.json()) as { data: { id: string }[] };
    const ids = json.data.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("GLM-5.2");
    expect(ids).toContain("MiniMax-M3[1m]");
    expect(ids).toContain("MiniMax-M2.7-highspeed");
  });
});

describe("notFound", () => {
  test("404 + path 信息", async () => {
    const res = notFound("/foo");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("/foo");
  });
});

describe("badRequest", () => {
  test("400 + supported_models", async () => {
    const res = badRequest("reason", ["a", "b"]);
    const json = (await res.json()) as { error: { supported_models: string[] } };
    expect(json.error.supported_models).toEqual(["a", "b"]);
  });
});

describe("health", () => {
  test("返回 ok + supported_models + name=ai-gw", async () => {
    const res = health(config.routes);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.name).toBe("ai-gw");
    expect(Array.isArray(json.supported_models)).toBe(true);
  });
});

describe("handleMessages", () => {
  test("body 非 JSON → 400", async () => {
    const req = new Request("https://x/v1/messages", {
      method: "POST",
      body: "not json",
    });
    const res = await handleMessages(req, config);
    expect(res.status).toBe(400);
  });

  test("缺 model → 400 + supported_models", async () => {
    const req = new Request("https://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });
    const res = await handleMessages(req, config);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { supported_models: string[] } };
    expect(json.error.supported_models).toBeDefined();
  });

  test("不支持的 model → 400", async () => {
    const req = new Request("https://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "unknown-model" }),
    });
    const res = await handleMessages(req, config);
    expect(res.status).toBe(400);
  });

  test("secret 未配置 → 500 config_error", async () => {
    // 构造一个不含 CCC_GLM_AUTH_TOKEN 的 config
    const noGlmConfig: AppConfig = {
      ...config,
      secrets: { CCC_MINIMAX_AUTH_TOKEN: "mm-token" },
    };
    const req = new Request("https://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "GLM-5.2", messages: [] }),
    });
    const res = await handleMessages(req, noGlmConfig, mockFetchOk());
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("config_error");
    // 未触达 fetch
    expect(holder.v).toBeNull();
  });

  test("GLM-5.2[1m] 重写为 GLM-5.2 + 注入 glm secret", async () => {
    holder.v = null;
    const req = new Request("https://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "GLM-5.2[1m]", messages: [] }),
    });
    const res = await handleMessages(req, config, mockFetchOk());
    expect(res.status).toBe(200);
    expect(holder.v!.url).toBe(
      "https://open.bigmodel.cn/api/anthropic/v1/messages"
    );
    expect(holder.v!.apiKey).toBe("glm-token");
    expect(JSON.parse(holder.v!.body).model).toBe("GLM-5.2");
  });

  test("MiniMax-M3[1m] upstreamId 保留 [1m]（不重写）", async () => {
    holder.v = null;
    const req = new Request("https://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "MiniMax-M3[1m]", messages: [] }),
    });
    await handleMessages(req, config, mockFetchOk());
    expect(JSON.parse(holder.v!.body).model).toBe("MiniMax-M3[1m]");
    expect(holder.v!.apiKey).toBe("mm-token");
  });

  test("SSE 响应透传（status + content-type + request-id）", async () => {
    holder.v = null;
    const req = new Request("https://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "GLM-5.2", messages: [] }),
    });
    const res = await handleMessages(req, config, mockFetchOk());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("request-id")).toBe("req-1");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const text = await res.text();
    expect(text).toBe("data: ok\n\n");
  });

  test("缺 anthropic-version → 上游默认 2023-06-01", async () => {
    holder.v = null;
    const req = new Request("https://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "GLM-5.2", messages: [] }),
      // 故意不设 anthropic-version
    });
    await handleMessages(req, config, mockFetchOk());
    expect(holder.v!.anthropicVersion).toBe("2023-06-01");
    expect(holder.v!.anthropicBeta).toBeNull();
  });

  test("client 传 anthropic-beta → 透传上游", async () => {
    holder.v = null;
    const req = new Request("https://x/v1/messages", {
      method: "POST",
      headers: { "anthropic-beta": "x-test-1" },
      body: JSON.stringify({ model: "GLM-5.2", messages: [] }),
    });
    await handleMessages(req, config, mockFetchOk());
    expect(holder.v!.anthropicBeta).toBe("x-test-1");
  });

  test("fetch 抛错 → 502 upstream_error", async () => {
    const failFetch = (() =>
      Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    const req = new Request("https://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "GLM-5.2", messages: [] }),
    });
    const res = await handleMessages(req, config, failFetch);
    expect(res.status).toBe(502);
  });
});
