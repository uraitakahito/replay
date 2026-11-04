import { describe, expect, it } from "vitest";
import type { BundlePage } from "../src/replay-bundle.js";
import { BundleFormatError, parsePagesJson, queryPages } from "../src/replay-bundle.js";

type Row = Partial<BundlePage> & Pick<BundlePage, "id" | "url">;

const page = (row: Row): BundlePage => ({
  ts: "2026-11-05T01:00:00.000Z",
  title: null,
  filename: `${row.id}.wacz`,
  depth: 0,
  stage: null,
  keys: [row.url],
  ...row,
});

const pagesJson = (rows: readonly Row[]): string =>
  JSON.stringify({ version: 1, crawlId: "c1", rev: 1, pages: rows.map(page) });

const ids = (answer: { items: readonly { id: string }[] }) => answer.items.map((item) => item.id);

const all = { page: 1, pageSize: 100 };

describe("parsePagesJson（合本の pages.json の形 v1）", () => {
  it("無い欄（ts・title・stage・depth）は null として読む", () => {
    const index = parsePagesJson(
      JSON.stringify({
        version: 1,
        pages: [{ id: "a", url: "http://site.test/", filename: "a.wacz", keys: [] }],
      }),
    );
    expect(index.pages[0]).toMatchObject({ ts: null, title: null, stage: null, depth: null });
  });

  it.each([
    ["JSON でない", "{"],
    ["object でない", "[]"],
    ["版が 1 でない", JSON.stringify({ version: 2, pages: [] })],
    ["版が無い", JSON.stringify({ pages: [] })],
    ["pages が配列でない", JSON.stringify({ version: 1, pages: {} })],
    [
      "行に id が無い",
      JSON.stringify({ version: 1, pages: [{ url: "u", filename: "f", keys: [] }] }),
    ],
    [
      "行に url が無い",
      JSON.stringify({ version: 1, pages: [{ id: "i", filename: "f", keys: [] }] }),
    ],
    [
      "行に filename が無い",
      JSON.stringify({ version: 1, pages: [{ id: "i", url: "u", keys: [] }] }),
    ],
    ["keys が無い", JSON.stringify({ version: 1, pages: [{ id: "i", url: "u", filename: "f" }] })],
    [
      "keys が文字列の配列でない",
      JSON.stringify({ version: 1, pages: [{ id: "i", url: "u", filename: "f", keys: [1] }] }),
    ],
    [
      "depth が数でない",
      JSON.stringify({
        version: 1,
        pages: [{ id: "i", url: "u", filename: "f", keys: [], depth: "0" }],
      }),
    ],
  ])("%s物は断る", (_, text) => {
    expect(() => parsePagesJson(text)).toThrow(BundleFormatError);
  });
});

describe("queryPages の ?url=（頁を開くときの問い）", () => {
  it("keys が同じ行を先に、keys が問いで始まる行を後に返す（深さで先の行より、同じ行が先）", () => {
    const index = parsePagesJson(
      pagesJson([
        { id: "child", url: "http://site.test/a/b", depth: 0 },
        { id: "exact", url: "http://site.test/a", depth: 2 },
        { id: "other", url: "http://site.test/z", depth: 0 },
      ]),
    );
    const answer = queryPages(index, { url: "http://site.test/a", ...all });
    expect(ids(answer)).toEqual(["exact", "child"]);
    expect(answer.total).toBe(2);
  });

  it("問いを正規化してから比べる（大文字の scheme と host・fragment）", () => {
    const index = parsePagesJson(pagesJson([{ id: "hub", url: "http://site.test/hub" }]));
    expect(ids(queryPages(index, { url: "HTTP://SITE.test/hub#top", ...all }))).toEqual(["hub"]);
  });

  it("答えの url は当たった key（リダイレクトの後の URL で当たった行も、その URL を返す）", () => {
    const index = parsePagesJson(
      pagesJson([
        {
          id: "moved",
          url: "http://site.test/old",
          keys: ["http://site.test/old", "http://site.test/new"],
        },
      ]),
    );
    const answer = queryPages(index, { url: "http://site.test/new", ...all });
    expect(answer.items).toEqual([
      {
        id: "moved",
        url: "http://site.test/new",
        ts: "2026-11-05T01:00:00.000Z",
        title: null,
        filename: "moved.wacz",
      },
    ]);
  });

  it("前方一致の行の url は、問いで始まる key", () => {
    const index = parsePagesJson(pagesJson([{ id: "leaf", url: "http://site.test/hub/leaf" }]));
    expect(queryPages(index, { url: "http://site.test/hub", ...all }).items[0]?.url).toBe(
      "http://site.test/hub/leaf",
    );
  });

  it("写しの行（keys が空）は ?url= で返さない", () => {
    const index = parsePagesJson(
      pagesJson([
        { id: "doc", url: "http://site.test/" },
        {
          id: "doc-after-load",
          url: "urn:browserhive:snapshot:after-load:http://site.test/",
          stage: "after-load",
          keys: [],
        },
      ]),
    );
    expect(ids(queryPages(index, { url: "http://site.test/", ...all }))).toEqual(["doc"]);
  });

  it.each(["mailto:someone@site.test", "not a url", ""])(
    "http(s) でない問い「%s」は 0 件",
    (url) => {
      const index = parsePagesJson(pagesJson([{ id: "doc", url: "http://site.test/" }]));
      expect(queryPages(index, { url, ...all })).toEqual({ items: [], total: 0 });
    },
  );
});

describe("queryPages の ?search=（一覧の検索と、query を外した問い直し）", () => {
  const index = parsePagesJson(
    pagesJson([
      {
        id: "about",
        url: "http://other-site.test/about",
        title: "About http://site.test/list",
        depth: 0,
      },
      { id: "list-2", url: "http://site.test/list?page=2", title: "List", depth: 1 },
      { id: "leaf", url: "http://site.test/leaf/1", title: "Leaf One", depth: 1 },
    ]),
  );

  it("url か title が語を含む行を返す（大小を区別しない）", () => {
    expect(ids(queryPages(index, { search: "LEAF", ...all }))).toEqual(["leaf"]);
    expect(ids(queryPages(index, { search: "one", ...all }))).toEqual(["leaf"]);
  });

  it("url が語で始まる行を先に返す（深さで先の行より先）", () => {
    expect(ids(queryPages(index, { search: "http://site.test/list", ...all }))).toEqual([
      "list-2",
      "about",
    ]);
  });
});

describe("queryPages の並びと区切り", () => {
  it("問いが無ければ全部の行を、深さ → 時刻 → id の順に返す（無い深さと時刻は後ろ）", () => {
    const index = parsePagesJson(
      pagesJson([
        { id: "no-depth", url: "http://site.test/n", depth: null },
        { id: "d1-late", url: "http://site.test/l", depth: 1, ts: "2026-11-05T03:00:00.000Z" },
        { id: "d1-b", url: "http://site.test/b", depth: 1, ts: "2026-11-05T02:00:00.000Z" },
        { id: "d1-a", url: "http://site.test/a", depth: 1, ts: "2026-11-05T02:00:00.000Z" },
        { id: "d1-no-ts", url: "http://site.test/t", depth: 1, ts: null },
        { id: "d0", url: "http://site.test/", depth: 0, ts: "2026-11-05T09:00:00.000Z" },
      ]),
    );
    expect(ids(queryPages(index, all))).toEqual([
      "d0",
      "d1-a",
      "d1-b",
      "d1-late",
      "d1-no-ts",
      "no-depth",
    ]);
  });

  it("page と pageSize で区切り、total は区切る前の数", () => {
    const rows = Array.from({ length: 7 }, (_, n) => ({
      id: `p${String(n)}`,
      url: `http://site.test/${String(n)}`,
      depth: n,
    }));
    const index = parsePagesJson(pagesJson(rows));
    const answer = queryPages(index, { page: 2, pageSize: 3 });
    expect(ids(answer)).toEqual(["p3", "p4", "p5"]);
    expect(answer.total).toBe(7);
    expect(ids(queryPages(index, { page: 3, pageSize: 3 }))).toEqual(["p6"]);
    expect(queryPages(index, { page: 4, pageSize: 3 }).items).toEqual([]);
  });
});
