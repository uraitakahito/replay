import { describe, expect, it } from "vitest";
import { decodeKeyPath, encodeKeyPath, encodeKeySegment } from "../src/key-path.js";

describe("decodeKeyPath（鍵を区切りごとに 1 度だけ解く）", () => {
  it("%25 は % になり、2 度目は解かない", () => {
    expect(decodeKeyPath("org/acme/hello%2520world.wacz")).toEqual({
      ok: true,
      segments: ["org", "acme", "hello%20world.wacz"],
    });
  });

  it("日本語の区切りも 1 度だけ解く", () => {
    expect(decodeKeyPath("a/%E6%97%A5%E6%9C%AC.wacz")).toEqual({
      ok: true,
      segments: ["a", "日本.wacz"],
    });
  });

  it("空の区切りはそのまま残す（併せない）", () => {
    expect(decodeKeyPath("a//b")).toEqual({ ok: true, segments: ["a", "", "b"] });
  });

  it("名前の一部の点（..a・a..・.wacz）は通す", () => {
    expect(decodeKeyPath("..a/a../.wacz")).toEqual({ ok: true, segments: ["..a", "a..", ".wacz"] });
  });

  it.each(["..", ".", "a/../b", "a/./b", "%2e%2e/x", "%2E", "a%2F..%2Fb", "..%2Fx", "x/%2e"])(
    "「%s」は . と .. の区切りとして断る",
    (raw) => {
      const decoded = decodeKeyPath(raw);
      expect(decoded.ok).toBe(false);
    },
  );

  it.each(["a%ZZ", "%E3%81", "%"])("壊れた百分率の符号「%s」は断る", (raw) => {
    expect(decodeKeyPath(raw).ok).toBe(false);
  });
});

describe("encodeKeyPath（上流へ渡す path に組み直す）", () => {
  it("解いて組み直すと、保管庫が 1 度解いて元の鍵に戻る形になる", () => {
    const decoded = decodeKeyPath("a/hello%2520world.wacz");
    if (!decoded.ok) throw new Error(decoded.reason);
    const encoded = encodeKeyPath(decoded.segments);
    expect(encoded).toBe("a/hello%2520world.wacz");
    expect(decodeURIComponent(encoded)).toBe("a/hello%20world.wacz");
  });

  it("区切りの中の / は %2F のまま渡す", () => {
    expect(encodeKeyPath(["a/b", "c"])).toBe("a%2Fb/c");
  });

  it("unreserved（英数字と -._~）のほかは全部符号にする", () => {
    expect(encodeKeySegment("aZ09-._~ +!'()*%日")).toBe(
      "aZ09-._~%20%2B%21%27%28%29%2A%25%E6%97%A5",
    );
  });
});
