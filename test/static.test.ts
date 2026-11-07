import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STATIC_CONTENT, cleanupTemporaryDirectories } from "./helpers/files.js";
import { corsHeadersOf, send } from "./helpers/net.js";
import type { TestViewer } from "./helpers/viewer.js";
import { startViewer } from "./helpers/viewer.js";

let viewer: TestViewer;

beforeAll(async () => {
  // 静的な物は保管庫を読まない。名前の引けない保管庫を指したまま起こす
  viewer = await startViewer("http://seaweedfs.crawler-storage:8333/browserhive");
});

afterAll(async () => {
  await viewer.close();
  cleanupTemporaryDirectories();
});

describe("ReplayWeb.page の 3 つ", () => {
  it.each(["/", "/index.html", "/?source=/wacz/a.wacz"])(
    "%s は index.html を text/html; charset=utf-8 で返す",
    async (path) => {
      const res = await send(viewer.base, path);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(res.body.toString("utf8")).toBe(STATIC_CONTENT["index.html"]);
    },
  );

  it.each(["/ui.js", "/sw.js"] as const)(
    "%s は text/javascript; charset=utf-8 で、全体を返す",
    async (path) => {
      const res = await send(viewer.base, path);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      const expected = Buffer.from(STATIC_CONTENT[path === "/ui.js" ? "ui.js" : "sw.js"]);
      expect(res.headers["content-length"]).toBe(String(expected.length));
      expect(res.body.equals(expected)).toBe(true);
    },
  );
});

describe("image が焼いた 3 つ", () => {
  it("/__version は application/json で、焼いた欄と末尾の改行をそのまま返す", async () => {
    const res = await send(viewer.base, "/__version");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.body.toString("utf8")).toBe(STATIC_CONTENT.__version);
    expect(Object.keys(JSON.parse(res.body.toString("utf8")) as object)).toEqual([
      "version",
      "revision",
      "replaywebpage",
    ]);
  });

  it("/SOURCE.txt は text/plain で返す", async () => {
    const res = await send(viewer.base, "/SOURCE.txt");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(res.body.toString("utf8")).toBe(STATIC_CONTENT["SOURCE.txt"]);
  });

  it("/LICENSE-replaywebpage を読める形で返す", async () => {
    const res = await send(viewer.base, "/LICENSE-replaywebpage");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.body.toString("utf8")).toBe(STATIC_CONTENT["LICENSE-replaywebpage"]);
  });
});

describe("ほかの path", () => {
  it.each([
    "/ruffle/ruffle.js",
    "/webmanifest.json",
    "/favicons/favicon.ico",
    "/index.htm",
    "/ui.js/",
    "/public/ui.js",
    "/wacz",
    "/q",
    "/q/org/x",
  ])("%s は 404", async (path) => {
    const res = await send(viewer.base, path);
    expect(res.status).toBe(404);
  });

  it("path でない要求の対象は 400", async () => {
    const res = await send(viewer.base, "*", { method: "OPTIONS" });
    expect(res.status).toBe(400);
  });
});

describe("条件つきの要求・HEAD・method", () => {
  it("ETag が合えば 304 で、本文を返さない", async () => {
    const first = await send(viewer.base, "/sw.js");
    const etag = first.headers.etag;
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    const again = await send(viewer.base, "/sw.js", { headers: { "if-none-match": `W/${etag!}` } });
    expect(again.status).toBe(304);
    expect(again.headers.etag).toBe(etag);
    expect(again.body.length).toBe(0);
  });

  it("ETag が違えば 200 で全体を返す", async () => {
    const res = await send(viewer.base, "/sw.js", { headers: { "if-none-match": '"other"' } });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(Buffer.byteLength(STATIC_CONTENT["sw.js"]));
  });

  it("If-Modified-Since が Last-Modified より新しければ 304、古ければ 200", async () => {
    const first = await send(viewer.base, "/ui.js");
    const lastModified = first.headers["last-modified"]!;
    const later = new Date(Date.parse(lastModified) + 60_000).toUTCString();
    const earlier = new Date(Date.parse(lastModified) - 60_000).toUTCString();
    expect(
      (await send(viewer.base, "/ui.js", { headers: { "if-modified-since": later } })).status,
    ).toBe(304);
    expect(
      (await send(viewer.base, "/ui.js", { headers: { "if-modified-since": earlier } })).status,
    ).toBe(200);
  });

  it("HEAD は header だけを返す（Content-Length は本文の長さ）", async () => {
    const res = await send(viewer.base, "/sw.js", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(STATIC_CONTENT["sw.js"])));
    expect(res.body.length).toBe(0);
  });

  it.each(["POST", "PUT", "DELETE"])(
    "%s は 405 で、Allow に GET と HEAD を返す",
    async (method) => {
      const res = await send(viewer.base, "/", { method });
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe("GET, HEAD");
    },
  );
});

describe("CORS", () => {
  it.each([
    "/",
    "/sw.js",
    "/__version",
    "/ruffle/ruffle.js",
    "/wacz/x.wacz",
    "/q/org/a/crawls/b/r1/pages",
  ])("%s の答えに CORS の header を付けない", async (path) => {
    const res = await send(viewer.base, path, { headers: { origin: "https://other-site.test" } });
    expect(res.status).toBeGreaterThan(0);
    expect(corsHeadersOf(res.headers)).toEqual([]);
  });
});
