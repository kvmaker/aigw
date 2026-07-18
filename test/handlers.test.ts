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
    holder.v = null;
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
    expect(holder.v!.anthropicVersion).toBe("2023-06-01");
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

// === fallback（多候选）测试 ===

// 主 kimi-k3 带 2 条 fallback：glm、minimax
const fbConfig: AppConfig = {
  routerToken: "secret",
  routes: {
    "kimi-k3": {
      baseUrl: "https://ark.example.com/api/plan",
      secretKey: "CCC_ARK_AUTH_TOKEN",
      upstreamId: "kimi-k3",
      fallbacks: [
        {
          baseUrl: "https://glm.example.com/api/anthropic",
          secretKey: "CCC_GLM_AUTH_TOKEN",
          upstreamId: "GLM-5.2",
        },
        {
          baseUrl: "https://mm.example.com/anthropic",
          secretKey: "CCC_MINIMAX_AUTH_TOKEN",
          upstreamId: "MiniMax-M3[1m]",
        },
      ],
    },
  },
  secrets: {
    CCC_ARK_AUTH_TOKEN: "ark-token",
    CCC_GLM_AUTH_TOKEN: "glm-token",
    CCC_MINIMAX_AUTH_TOKEN: "mm-token",
  },
  port: 8787,
  host: "127.0.0.1",
};

const sseResp = () =>
  new Response("data: ok\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req-1" },
  });
const errResp = (status: number, body = "error") =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });

// 按序返回预设响应；responders 里的 Error 实例会被 throw（模拟网络错）。
function mockFetchSeq(responders: (Response | Error)[]) {
  const calls: Captured[] = [];
  let i = 0;
  const fn = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers as HeadersInit);
    calls.push({
      url,
      apiKey: headers.get("x-api-key")!,
      body: init.body as string,
      anthropicVersion: headers.get("anthropic-version"),
      anthropicBeta: headers.get("anthropic-beta"),
    });
    if (i >= responders.length) {
      throw new Error(`mockFetchSeq: no responder for call #${i} (${url})`);
    }
    const r = responders[i++];
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { fn, calls };
}

const fbReq = () =>
  new Request("https://x/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "kimi-k3", messages: [] }),
  });

describe("handleMessages · fallback", () => {
  test("主 5xx → 备 200 → 透传 200，命中备 baseUrl", async () => {
    const { fn, calls } = mockFetchSeq([errResp(503), sseResp()]);
    const res = await handleMessages(fbReq(), fbConfig, fn);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://ark.example.com/api/plan/v1/messages");
    expect(calls[1].url).toBe("https://glm.example.com/api/anthropic/v1/messages");
  });

  test("主 429 → 备 200 → 透传 200", async () => {
    const { fn, calls } = mockFetchSeq([errResp(429), sseResp()]);
    const res = await handleMessages(fbReq(), fbConfig, fn);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test("主 200 → 不调备", async () => {
    const { fn, calls } = mockFetchSeq([sseResp()]);
    const res = await handleMessages(fbReq(), fbConfig, fn);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("主 4xx → 不调备，透传主 4xx", async () => {
    const { fn, calls } = mockFetchSeq([errResp(400, "bad")]);
    const res = await handleMessages(fbReq(), fbConfig, fn);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(1);
    expect(await res.text()).toBe("bad");
  });

  test("主 5xx + 备 4xx → 透传备 4xx（停止 fallback）", async () => {
    const { fn, calls } = mockFetchSeq([
      errResp(503),
      errResp(400, "client err"),
    ]);
    const res = await handleMessages(fbReq(), fbConfig, fn);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(2);
    expect(await res.text()).toBe("client err");
  });

  test("候选链全部 5xx → 聚合 502，candidates 含每个 status", async () => {
    const { fn, calls } = mockFetchSeq([
      errResp(503),
      errResp(500),
      errResp(502),
    ]);
    const res = await handleMessages(fbReq(), fbConfig, fn);
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(3);
    const json = (await res.json()) as {
      error: { type: string; candidates: { status?: number; reason: string }[] };
    };
    expect(json.error.type).toBe("all_upstreams_failed");
    expect(json.error.candidates).toHaveLength(3);
    expect(json.error.candidates.map((c) => c.status)).toEqual([503, 500, 502]);
    expect(json.error.candidates.every((c) => c.reason === "http")).toBe(true);
  });

  test("主网络错 + 备 200 → 透传 200", async () => {
    const { fn, calls } = mockFetchSeq([new Error("network down"), sseResp()]);
    const res = await handleMessages(fbReq(), fbConfig, fn);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test("候选链全部网络错 → 聚合 502，candidates 全 network", async () => {
    const { fn, calls } = mockFetchSeq([
      new Error("down1"),
      new Error("down2"),
      new Error("down3"),
    ]);
    const res = await handleMessages(fbReq(), fbConfig, fn);
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(3);
    const json = (await res.json()) as {
      error: { candidates: { reason: string; message: string }[] };
    };
    expect(json.error.candidates).toHaveLength(3);
    expect(json.error.candidates.every((c) => c.reason === "network")).toBe(
      true
    );
    expect(json.error.candidates[0].message).toContain("down1");
  });

  test("主 secret 缺失 → 跳过主，调备 200", async () => {
    const noArk: AppConfig = {
      ...fbConfig,
      secrets: {
        CCC_GLM_AUTH_TOKEN: "glm-token",
        CCC_MINIMAX_AUTH_TOKEN: "mm-token",
      },
    };
    const { fn, calls } = mockFetchSeq([sseResp()]);
    const res = await handleMessages(fbReq(), noArk, fn);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://glm.example.com/api/anthropic/v1/messages");
  });

  test("主备 secret 全缺 → 500 config_error，未触达 fetch", async () => {
    const noSecrets: AppConfig = { ...fbConfig, secrets: {} };
    const { fn, calls } = mockFetchSeq([sseResp()]);
    const res = await handleMessages(fbReq(), noSecrets, fn);
    expect(res.status).toBe(500);
    expect(calls).toHaveLength(0);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("config_error");
  });

  test("三候选：主 5xx → 备A 5xx → 备B 200 → 透传 B", async () => {
    const { fn, calls } = mockFetchSeq([
      errResp(503),
      errResp(500),
      sseResp(),
    ]);
    const res = await handleMessages(fbReq(), fbConfig, fn);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(calls[2].url).toBe("https://mm.example.com/anthropic/v1/messages");
  });

  test("per-candidate model 重写：主不重写，备按 upstreamId 重写", async () => {
    const { fn, calls } = mockFetchSeq([errResp(503), sseResp()]);
    await handleMessages(fbReq(), fbConfig, fn);
    expect(JSON.parse(calls[0].body).model).toBe("kimi-k3");
    expect(JSON.parse(calls[1].body).model).toBe("GLM-5.2");
  });
});
