import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeModel,
  DEFAULT_ROUTES,
  loadRoutesFromEnv,
  loadRoutesFromYaml,
  loadConfig,
  ConfigError,
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
  test("kimi-k3[1m] 与 kimi-k3 都命中同一上游（/api/plan 端点）", () => {
    const up1 = DEFAULT_ROUTES[normalizeModel("kimi-k3[1m]")];
    const up2 = DEFAULT_ROUTES[normalizeModel("kimi-k3")];
    expect(up1).toBeDefined();
    expect(up2).toBeDefined();
    expect(up1).toBe(up2);
    expect(up1.upstreamId).toBe("kimi-k3");
    expect(up1.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/plan");
    expect(up1.secretKey).toBe("CCC_ARK_AUTH_TOKEN");
  });
  test("所有默认上游均无 fallbacks（向后兼容）", () => {
    for (const up of Object.values(DEFAULT_ROUTES)) {
      expect(up.fallbacks).toBeUndefined();
    }
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
  test("解析带 fallbacks 的 entry（顺序保留 + secret→secretKey 映射）", () => {
    const routes = loadRoutesFromEnv(
      '[{"aliases":["kimi-k3"],"baseUrl":"https://ark.example.com","secret":"CCC_ARK","upstreamId":"kimi-k3","fallbacks":[{"baseUrl":"https://glm.example.com","secret":"CCC_GLM","upstreamId":"GLM-5.2"},{"baseUrl":"https://mm.example.com","secret":"CCC_MM","upstreamId":"MiniMax-M3"}]}]'
    );
    const up = routes["kimi-k3"];
    expect(up).toBeDefined();
    expect(up.fallbacks).toHaveLength(2);
    expect(up.fallbacks![0].baseUrl).toBe("https://glm.example.com");
    expect(up.fallbacks![0].secretKey).toBe("CCC_GLM");
    expect(up.fallbacks![0].upstreamId).toBe("GLM-5.2");
    expect(up.fallbacks![0].fallbacks).toBeUndefined();
    expect(up.fallbacks![1].upstreamId).toBe("MiniMax-M3");
    expect(up.fallbacks![1].secretKey).toBe("CCC_MM");
  });
  test("无 fallbacks 字段时 up.fallbacks === undefined（向后兼容）", () => {
    const routes = loadRoutesFromEnv(
      '[{"aliases":["x"],"baseUrl":"https://x.example.com","secret":"CCC_X","upstreamId":"x"}]'
    );
    expect(routes["x"].fallbacks).toBeUndefined();
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
      CCC_ARK_AUTH_TOKEN: "ark",
      PORT: "9000",
      HOST: "0.0.0.0",
    });
    expect(cfg.routerToken).toBe("tok");
    expect(cfg.secrets.CCC_MINIMAX_AUTH_TOKEN).toBe("mm");
    expect(cfg.secrets.CCC_GLM_AUTH_TOKEN).toBe("glm");
    expect(cfg.secrets.CCC_ARK_AUTH_TOKEN).toBe("ark");
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

// ===== B01: YAML 配置 =====

describe("loadRoutesFromYaml", () => {
  test("解析 {routes:[...]} 形态，aliases 展开为 key，secretKey 保留", () => {
    const routes = loadRoutesFromYaml(`
routes:
  - aliases: ["glm-5.2", "glm-5.2[1m]"]
    upstream:
      baseUrl: https://open.bigmodel.cn/api/anthropic
      secretKey: CCC_GLM_AUTH_TOKEN
      upstreamId: GLM-5.2
`);
    expect(routes["glm-5.2"]).toBeDefined();
    expect(routes["glm-5.2"].upstreamId).toBe("GLM-5.2");
    expect(routes["glm-5.2"].secretKey).toBe("CCC_GLM_AUTH_TOKEN");
    expect(routes["glm-5.2"].baseUrl).toBe(
      "https://open.bigmodel.cn/api/anthropic"
    );
    expect(routes["glm-5.2"].fallbacks).toBeUndefined();
  });

  test("顶层直接是数组也能解析", () => {
    const routes = loadRoutesFromYaml(`
- aliases: ["x"]
  upstream:
    baseUrl: https://x.example.com
    secretKey: CCC_X
    upstreamId: x
`);
    expect(routes["x"]).toBeDefined();
    expect(routes["x"].upstreamId).toBe("x");
  });

  test("解析带 fallbacks 的 entry（顺序保留 + secretKey 映射）", () => {
    const routes = loadRoutesFromYaml(`
routes:
  - aliases: ["kimi-k3"]
    upstream:
      baseUrl: https://ark.example.com
      secretKey: CCC_ARK
      upstreamId: kimi-k3
    fallbacks:
      - baseUrl: https://glm.example.com
        secretKey: CCC_GLM
        upstreamId: GLM-5.2
      - baseUrl: https://mm.example.com
        secretKey: CCC_MM
        upstreamId: MiniMax-M3
`);
    const up = routes["kimi-k3"];
    expect(up.fallbacks).toHaveLength(2);
    expect(up.fallbacks![0].secretKey).toBe("CCC_GLM");
    expect(up.fallbacks![0].upstreamId).toBe("GLM-5.2");
    expect(up.fallbacks![1].upstreamId).toBe("MiniMax-M3");
    // 单层 fallback：候选不再嵌套 fallbacks
    expect(up.fallbacks![0].fallbacks).toBeUndefined();
  });

  test("空 fallbacks 数组视为 undefined（向后兼容）", () => {
    const routes = loadRoutesFromYaml(`
routes:
  - aliases: ["x"]
    upstream:
      baseUrl: https://x.example.com
      secretKey: CCC_X
      upstreamId: x
    fallbacks: []
`);
    expect(routes["x"].fallbacks).toBeUndefined();
  });

  test("aliases 展开时做 normalize（剥 [1m] + 小写）", () => {
    const routes = loadRoutesFromYaml(`
routes:
  - aliases: ["GLM-5.2[1m]"]
    upstream:
      baseUrl: https://x.example.com
      secretKey: CCC_X
      upstreamId: GLM-5.2
`);
    expect(routes["glm-5.2"]).toBeDefined();
    expect(routes["GLM-5.2[1m]"]).toBeUndefined();
  });

  // ---- schema 校验 fail-fast ----
  test("缺 aliases 抛 ConfigError", () => {
    expect(() =>
      loadRoutesFromYaml(`
routes:
  - upstream:
      baseUrl: https://x.example.com
      secretKey: CCC_X
      upstreamId: x
`)
    ).toThrow(/aliases/);
  });

  test("空 aliases 数组抛 ConfigError", () => {
    expect(() =>
      loadRoutesFromYaml(`
routes:
  - aliases: []
    upstream:
      baseUrl: https://x.example.com
      secretKey: CCC_X
      upstreamId: x
`)
    ).toThrow(/aliases/);
  });

  test("缺 upstream 抛 ConfigError", () => {
    expect(() =>
      loadRoutesFromYaml(`
routes:
  - aliases: ["x"]
`)
    ).toThrow(/upstream/);
  });

  test("baseUrl 非法 URL 抛 ConfigError", () => {
    expect(() =>
      loadRoutesFromYaml(`
routes:
  - aliases: ["x"]
    upstream:
      baseUrl: not-a-url
      secretKey: CCC_X
      upstreamId: x
`)
    ).toThrow(/baseUrl/);
  });

  test("baseUrl 非 http/https 抛 ConfigError", () => {
    expect(() =>
      loadRoutesFromYaml(`
routes:
  - aliases: ["x"]
    upstream:
      baseUrl: ftp://x.example.com
      secretKey: CCC_X
      upstreamId: x
`)
    ).toThrow(/http\/https/);
  });

  test("secretKey 空抛 ConfigError", () => {
    expect(() =>
      loadRoutesFromYaml(`
routes:
  - aliases: ["x"]
    upstream:
      baseUrl: https://x.example.com
      secretKey: ""
      upstreamId: x
`)
    ).toThrow(/secretKey/);
  });

  test("upstreamId 缺失抛 ConfigError", () => {
    expect(() =>
      loadRoutesFromYaml(`
routes:
  - aliases: ["x"]
    upstream:
      baseUrl: https://x.example.com
      secretKey: CCC_X
`)
    ).toThrow(/upstreamId/);
  });

  test("fallbacks 非数组抛 ConfigError", () => {
    expect(() =>
      loadRoutesFromYaml(`
routes:
  - aliases: ["x"]
    upstream:
      baseUrl: https://x.example.com
      secretKey: CCC_X
      upstreamId: x
    fallbacks: "oops"
`)
    ).toThrow(/fallbacks/);
  });

  test("空 YAML 抛 ConfigError", () => {
    expect(() => loadRoutesFromYaml("")).toThrow(/empty/i);
    expect(() => loadRoutesFromYaml("---")).toThrow();
  });

  test("顶层既非数组也非 {routes:[]} 抛 ConfigError", () => {
    expect(() => loadRoutesFromYaml("foo: bar\n")).toThrow(/root/i);
  });

  test("空 routes 数组（{routes:[]}）抛 ConfigError", () => {
    expect(() => loadRoutesFromYaml("routes: []")).toThrow(/at least one entry/i);
  });

  test("顶层空数组（[]）抛 ConfigError", () => {
    expect(() => loadRoutesFromYaml("[]")).toThrow(/at least one entry/i);
  });
});

describe("loadConfig YAML 集成（三层优先级）", () => {
  const tmp = mkdtempSync(join(tmpdir(), "aigw-yaml-"));
  const yamlPath = join(tmp, "routes.yaml");
  writeFileSync(
    yamlPath,
    `routes:
  - aliases: ["glm-5.2"]
    upstream:
      baseUrl: https://yaml.example.com
      secretKey: CCC_GLM_AUTH_TOKEN
      upstreamId: GLM-5.2
  - aliases: ["yaml-only"]
    upstream:
      baseUrl: https://only.example.com
      secretKey: CCC_X
      upstreamId: yo
`,
    "utf8"
  );
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test("CCC_CONFIG_FILE 加载 YAML 并覆盖 DEFAULT_ROUTES 同名 key", () => {
    const cfg = loadConfig({ CCC_CONFIG_FILE: yamlPath });
    expect(cfg.routes["glm-5.2"].baseUrl).toBe("https://yaml.example.com");
  });

  test("YAML 新增的 key 也可命中（默认表里没有）", () => {
    const cfg = loadConfig({ CCC_CONFIG_FILE: yamlPath });
    expect(cfg.routes["yaml-only"]).toBeDefined();
    expect(cfg.routes["yaml-only"].upstreamId).toBe("yo");
  });

  test("三层优先级：CCC_ROUTES 覆盖 YAML，YAML 覆盖 DEFAULT_ROUTES", () => {
    const cfg = loadConfig({
      CCC_CONFIG_FILE: yamlPath,
      CCC_ROUTES:
        '[{"aliases":["glm-5.2"],"baseUrl":"https://env.example.com","secret":"CCC_GLM_AUTH_TOKEN","upstreamId":"GLM-5.2"}]',
    });
    // CCC_ROUTES（最高优先）胜出
    expect(cfg.routes["glm-5.2"].baseUrl).toBe("https://env.example.com");
  });

  test("不设 CCC_CONFIG_FILE 时行为不变（仅默认表）", () => {
    const cfg = loadConfig({});
    expect(cfg.routes["glm-5.2"].baseUrl).toBe(
      "https://open.bigmodel.cn/api/anthropic"
    );
    expect(cfg.routes["yaml-only"]).toBeUndefined();
  });

  test("CCC_CONFIG_FILE 指向不存在文件 → 抛 ConfigError", () => {
    expect(() =>
      loadConfig({ CCC_CONFIG_FILE: join(tmp, "nope.yaml") })
    ).toThrow(ConfigError);
  });

  test("CCC_CONFIG_FILE 指向 schema 非法的 YAML → 抛 ConfigError", () => {
    const badPath = join(tmp, "bad.yaml");
    writeFileSync(badPath, "routes:\n  - aliases: []\n", "utf8");
    expect(() => loadConfig({ CCC_CONFIG_FILE: badPath })).toThrow(ConfigError);
  });

  test("YAML 声明的自定义 secretKey（主 + fallback）被收集进 secrets", () => {
    const customPath = join(tmp, "custom.yaml");
    writeFileSync(
      customPath,
      `routes:
  - aliases: ["new-model"]
    upstream:
      baseUrl: https://new.example.com
      secretKey: CCC_NEW_TOKEN
      upstreamId: new-real
    fallbacks:
      - baseUrl: https://fb.example.com
        secretKey: CCC_FB_TOKEN
        upstreamId: fb-real
`,
      "utf8"
    );
    const cfg = loadConfig({
      CCC_CONFIG_FILE: customPath,
      CCC_NEW_TOKEN: "tok-new",
      CCC_FB_TOKEN: "tok-fb",
    });
    // 主 + fallback 的自定义 secretKey 都能从 env 解析（F3 修复核心断言）
    expect(cfg.secrets["CCC_NEW_TOKEN"]).toBe("tok-new");
    expect(cfg.secrets["CCC_FB_TOKEN"]).toBe("tok-fb");
    expect(cfg.routes["new-model"].secretKey).toBe("CCC_NEW_TOKEN");
    expect(cfg.routes["new-model"].fallbacks![0].secretKey).toBe("CCC_FB_TOKEN");
  });
});
