import { test, expect, describe } from "bun:test";
import { timingSafeEqual, verifyBearer, CORS_HEADERS } from "../src/auth";

describe("timingSafeEqual", () => {
  test("相同字符串返回 true", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
  });
  test("不同字符串返回 false", () => {
    expect(timingSafeEqual("abc", "abd")).toBe(false);
  });
  test("长度不同返回 false", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("CORS_HEADERS", () => {
  test("包含三个 CORS 头", () => {
    expect(CORS_HEADERS["Access-Control-Allow-Origin"]).toBe("*");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("POST");
    expect(CORS_HEADERS["Access-Control-Allow-Headers"]).toBe("*");
  });
});

describe("verifyBearer", () => {
  test("routerToken 未配置 → 500 config_error", () => {
    const res = verifyBearer(new Request("https://x/"), "");
    expect(res?.status).toBe(500);
  });
  test("缺 Authorization 头 → 401", () => {
    const res = verifyBearer(new Request("https://x/"), "secret");
    expect(res?.status).toBe(401);
  });
  test("错误 token → 401", () => {
    const req = new Request("https://x/", {
      headers: { Authorization: "Bearer wrong" },
    });
    const res = verifyBearer(req, "secret");
    expect(res?.status).toBe(401);
  });
  test("正确 token → null（通过）", () => {
    const req = new Request("https://x/", {
      headers: { Authorization: "Bearer secret" },
    });
    const res = verifyBearer(req, "secret");
    expect(res).toBeNull();
  });
  test("大小写不敏感（bearer 小写也接受）", () => {
    const req = new Request("https://x/", {
      headers: { Authorization: "bearer secret" },
    });
    const res = verifyBearer(req, "secret");
    expect(res).toBeNull();
  });
});
