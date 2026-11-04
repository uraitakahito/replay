import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalUrl } from "../src/canonical-url.js";

interface Vectors {
  readonly version: number;
  readonly cases: readonly { readonly input: string; readonly canonical: string | null }[];
}

// 合本の形 v1 の試験の例。capture-ledger が同じ物を写して、同じ式を縛る。
const vectors = JSON.parse(
  readFileSync(new URL("./vectors/canonical-url.json", import.meta.url), "utf8"),
) as Vectors;

describe("canonicalUrl（合本の URL の正規化）", () => {
  it("試験の例は形の版 1 で、例を持つ", () => {
    expect(vectors.version).toBe(1);
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  it.each(vectors.cases)("「$input」を $canonical にする", ({ input, canonical }) => {
    expect(canonicalUrl(input)).toBe(canonical);
  });

  it("replay が問いに入れる形（fragment を外した href）と同じになる", () => {
    for (const { input, canonical } of vectors.cases) {
      if (canonical === null) continue;
      const url = new URL(input);
      url.hash = "";
      expect(canonicalUrl(input)).toBe(url.href);
    }
  });
});
