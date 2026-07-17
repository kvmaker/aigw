import { test, expect, describe } from "bun:test";
import {
  normalizeModel,
  DEFAULT_ROUTES,
  loadRoutesFromEnv,
  loadConfig,
} from "../src/config";

describe("normalizeModel", () => {
  test("小写化", () => {
    expect(normalizeModel("GLM-5.2")).toBe("glm-5.2");
  });
  test("去掉 [1m] 后缀", () => {
    expect(normalizeModel("GLM-5.2[1m]")).toBe("glm-5.2");
    expect(normalizeModel("MiniMax-M3[1m]")).toBe("minimax-m3");
  });
  test("已 normalize 的不变", () => {
    expect(normalizeModel("glm-5.2")).toBe("glm-5.2");
  });
});

describe("DEFAULT_ROUTES", () => {
  test("GLM-5.2[1m] 命中且 upstreamId 为 GLM-5.2（无 [1m]）", () => {
    const up = DEFAULT_ROUTES[normalizeModel("GLM-5.2[1m]")];
    expect(up).toBeDefined();
    expect(up.upstreamId).toBe("GLM-5.2");
    expect(up.baseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
    expect(up.secretKey).toBe("CCC_GLM_AUTH_TOKEN");
  });
  test("MiniMax-M3[1m] 命中且 upstreamId 保留 [1m]", () => {
    const up = DEFAULT_ROUTES[normalizeModel("MiniMax-M3[1m]")];
    expect(up).toBeDefined();
    expect(up.upstreamId).toBe("MiniMax-M3[1m]");
    expect(up.secretKey).toBe("CCC_MINIMAX_AUTH_TOKEN");
  });
  test("MiniMax-M2.7-highspeed 命中", () => {
    const up = DEFAULT_ROUTES[normalizeModel("MiniMax-M2.7-highspeed")];
    expect(up).toBeDefined();
    expect(up.upstreamId).toBe("MiniMax-M2.7-highspeed");
  });
});

describe("loadRoutesFromEnv", () => {
  test("解析 CCC_ROUTES JSON，aliases 展开为 key", () => {
    const routes = loadRoutesFromEnv(
      '[{"aliases":["claude-opus-4","opus"],"baseUrl":"https://example.com","secret":"CCC_X_TOKEN","upstreamId":"real-opus"}]'
    );
    expect(routes["claude-opus-4"]).toBeDefined();
    expect(routes["opus"]).toBeDefined();
    expect(routes["claude-opus-4"].upstreamId).toBe("real-opus");
  });
  test("undefined 返回空对象", () => {
    expect(loadRoutesFromEnv(undefined)).toEqual({});
  });
});

describe("loadConfig", () => {
  test("空 env 给出默认端口/host 与空 token", () => {
    const cfg = loadConfig({});
    expect(cfg.port).toBe(8787);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.routerToken).toBe("");
  });
  test("读取 env 中的 token/secrets/port/host", () => {
    const cfg = loadConfig({
      CCC_ROUTER_TOKEN: "tok",
      CCC_MINIMAX_AUTH_TOKEN: "mm",
      CCC_GLM_AUTH_TOKEN: "glm",
      PORT: "9000",
      HOST: "0.0.0.0",
    });
    expect(cfg.routerToken).toBe("tok");
    expect(cfg.secrets.CCC_MINIMAX_AUTH_TOKEN).toBe("mm");
    expect(cfg.secrets.CCC_GLM_AUTH_TOKEN).toBe("glm");
    expect(cfg.port).toBe(9000);
    expect(cfg.host).toBe("0.0.0.0");
  });
  test("默认路由表已加载（含 glm-5.2）", () => {
    const cfg = loadConfig({});
    expect(cfg.routes["glm-5.2"]).toBeDefined();
  });
  test("CCC_ROUTES 与默认表合并（env 覆盖同 key）", () => {
    const cfg = loadConfig({
      CCC_ROUTES:
        '[{"aliases":["glm-5.2"],"baseUrl":"https://override.example.com","secret":"CCC_GLM_AUTH_TOKEN","upstreamId":"GLM-5.2"}]',
    });
    expect(cfg.routes["glm-5.2"].baseUrl).toBe("https://override.example.com");
  });
});
