import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupTemporaryDirectories } from "./helpers/files.js";
import { send, stubLookup } from "./helpers/net.js";
import type { TestReplay } from "./helpers/replay.js";
import { startReplay } from "./helpers/replay.js";
import type { StandInStore } from "./helpers/store.js";
import { BUCKET, STORE_HOST, startStore } from "./helpers/store.js";

const WACZ = Buffer.from(Array.from({ length: 1000 }, (_, n) => n % 251));

let store: StandInStore;
let replay: TestReplay;

beforeAll(async () => {
  store = await startStore();
  replay = await startReplay(store.bucketUrl, { upstreamTimeoutMs: 300 });
});

afterAll(async () => {
  await replay.close();
  await store.close();
  cleanupTemporaryDirectories();
});

beforeEach(() => {
  store.put("org/acme/2026-11/a_c1.wacz", WACZ);
});

afterEach(() => {
  store.requests.length = 0;
  replay.dns.calls.length = 0;
  store.delay(0);
  store.stallAfterFirstChunk(false);
  store.cutAfterFirstChunk(false);
  store.answerWith(undefined);
});

describe("/wacz/<鍵> の中継（範囲と条件）", () => {
  it("Range を渡し、206・Content-Range・Accept-Ranges・Content-Type をそのまま返す", async () => {
    const res = await send(replay.base, "/wacz/org/acme/2026-11/a_c1.wacz", {
      headers: { range: "bytes=10-19" },
    });
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 10-19/1000");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-type"]).toBe("application/wacz+zip");
    expect(res.headers["content-length"]).toBe("10");
    expect(res.body.equals(WACZ.subarray(10, 20))).toBe(true);
    expect(store.requests.map((seen) => seen.headers.range)).toEqual(["bytes=10-19"]);
  });

  it("If-Range・If-None-Match などの条件を渡し、保管庫の 304 をそのまま返す", async () => {
    const first = await send(replay.base, "/wacz/org/acme/2026-11/a_c1.wacz");
    const etag = first.headers.etag!;
    const res = await send(replay.base, "/wacz/org/acme/2026-11/a_c1.wacz", {
      headers: {
        "if-none-match": etag,
        "if-range": etag,
        "if-match": etag,
        "if-modified-since": "Thu, 05 Nov 2026 00:00:00 GMT",
        "if-unmodified-since": "Thu, 05 Nov 2026 00:00:00 GMT",
      },
    });
    expect(res.status).toBe(304);
    expect(res.body.length).toBe(0);
    const seen = store.requests[1]!.headers;
    expect(seen["if-none-match"]).toBe(etag);
    expect(seen["if-range"]).toBe(etag);
    expect(seen["if-match"]).toBe(etag);
    expect(seen["if-modified-since"]).toBe("Thu, 05 Nov 2026 00:00:00 GMT");
    expect(seen["if-unmodified-since"]).toBe("Thu, 05 Nov 2026 00:00:00 GMT");
  });

  it("Authorization は渡さない（同じ要求の Range は渡す）", async () => {
    const res = await send(replay.base, "/wacz/org/acme/2026-11/a_c1.wacz", {
      headers: { authorization: "Bearer secret", range: "bytes=0-0" },
    });
    expect(res.status).toBe(206);
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0]!.headers.range).toBe("bytes=0-0");
    expect(store.requests[0]!.headers.authorization).toBeUndefined();
  });

  it("範囲と条件のほかの header（Cookie・Origin など）も渡さない", async () => {
    await send(replay.base, "/wacz/org/acme/2026-11/a_c1.wacz", {
      headers: { cookie: "s=1", origin: "https://other-site.test", "x-amz-security-token": "t" },
    });
    const seen = store.requests[0]!.headers;
    expect(seen.cookie).toBeUndefined();
    expect(seen.origin).toBeUndefined();
    expect(seen["x-amz-security-token"]).toBeUndefined();
  });

  it("Host は保管庫の host:port にする", async () => {
    await send(replay.base, "/wacz/org/acme/2026-11/a_c1.wacz");
    expect(store.requests[0]!.headers.host).toBe(`${STORE_HOST}:${String(store.port)}`);
  });

  it("query は書いたとおりに渡す", async () => {
    await send(replay.base, "/wacz/org/acme/2026-11/a_c1.wacz?versionId=1&x=%2F+y");
    expect(store.requests[0]!.url).toBe(
      `/${BUCKET}/org/acme/2026-11/a_c1.wacz?versionId=1&x=%2F+y`,
    );
  });

  it("HEAD は HEAD のまま渡し、header だけを返す", async () => {
    const res = await send(replay.base, "/wacz/org/acme/2026-11/a_c1.wacz", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe("1000");
    expect(res.body.length).toBe(0);
    expect(store.requests[0]!.method).toBe("HEAD");
  });

  it("保管庫の 404 は status・header・本文をそのまま返す", async () => {
    const res = await send(replay.base, "/wacz/org/acme/missing.wacz");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("application/xml");
    expect(res.body.toString()).toBe(
      "<Error><Code>NoSuchKey</Code><Key>org/acme/missing.wacz</Key></Error>",
    );
  });

  it("保管庫が返す接続ごとの header（Connection が名指した物も）を外して返す", async () => {
    store.put("hop.wacz", WACZ, "application/wacz+zip", {
      connection: "x-hop",
      "keep-alive": "timeout=5",
      "x-hop": "1",
      "x-kept": "2",
    });
    const res = await send(replay.base, "/wacz/hop.wacz");
    expect(res.status).toBe(200);
    expect(res.headers["keep-alive"]).toBeUndefined();
    expect(res.headers["x-hop"]).toBeUndefined();
    expect(res.headers["x-kept"]).toBe("2");
  });
});

describe("/wacz/<鍵> の鍵の綴り", () => {
  it("%XX を含む鍵は 1 度だけ解き、保管庫に元の鍵で届く", async () => {
    // BrowserHive はラベルを百分率の符号で鍵に入れる: 鍵そのものが `%20` を含む
    store.put("c1_hello%20world.wacz", WACZ);
    const res = await send(replay.base, "/wacz/c1_hello%2520world.wacz");
    expect(res.status).toBe(200);
    expect(store.requests[0]!.url).toBe(`/${BUCKET}/c1_hello%2520world.wacz`);
    expect(store.requests[0]!.key).toBe("c1_hello%20world.wacz");
  });

  it("符号にした日本語の鍵も、同じ鍵で届く", async () => {
    store.put("c1_日本.wacz", WACZ);
    const res = await send(replay.base, "/wacz/c1_%E6%97%A5%E6%9C%AC.wacz");
    expect(res.status).toBe(200);
    expect(store.requests[0]!.key).toBe("c1_日本.wacz");
  });

  it.each([
    "..",
    "../other-bucket/x.wacz",
    "org/../x.wacz",
    "%2e%2e/x.wacz",
    "org%2F..%2Fx.wacz",
    "./x.wacz",
  ])("/wacz/%s は 400 で、保管庫へ何も送らない", async (key) => {
    const res = await send(replay.base, `/wacz/${key}`);
    expect(res.status).toBe(400);
    expect(store.requests).toEqual([]);
  });

  it("壊れた百分率の符号は 400 で、保管庫へ何も送らない", async () => {
    const res = await send(replay.base, "/wacz/a%ZZ.wacz");
    expect(res.status).toBe(400);
    expect(store.requests).toEqual([]);
  });

  it.each(["POST", "PUT", "DELETE"])("%s は 405 で、保管庫へ何も送らない", async (method) => {
    const res = await send(replay.base, "/wacz/org/acme/2026-11/a_c1.wacz", { method });
    expect(res.status).toBe(405);
    expect(store.requests).toEqual([]);
  });
});

describe("/wacz/<鍵> の届かない保管庫", () => {
  it("名前が引けなければ 502", async () => {
    const unresolved = await startReplay(store.bucketUrl, { lookup: stubLookup({}).lookup });
    try {
      const res = await send(unresolved.base, "/wacz/org/acme/2026-11/a_c1.wacz");
      expect(res.status).toBe(502);
      expect(res.body.toString()).toContain("ENOTFOUND");
    } finally {
      await unresolved.close();
    }
  });

  it("繋がらなければ 502", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const refused = await startReplay(`http://${STORE_HOST}:${String(port)}/${BUCKET}`);
    try {
      const res = await send(refused.base, "/wacz/x.wacz");
      expect(res.status).toBe(502);
      expect(res.body.toString()).toContain("ECONNREFUSED");
    } finally {
      await refused.close();
    }
  });

  it("保管庫が答えないまま時間が切れたら 504", async () => {
    store.delay(5_000);
    const res = await send(replay.base, "/wacz/org/acme/2026-11/a_c1.wacz");
    expect(res.status).toBe(504);
  });

  it("本文の途中で保管庫が黙ったら、受け手への接続も切る", async () => {
    store.stallAfterFirstChunk(true);
    await expect(send(replay.base, "/wacz/org/acme/2026-11/a_c1.wacz")).rejects.toThrow();
  });

  it("本文の途中で保管庫が切れたら、受け手への接続も切る", async () => {
    store.cutAfterFirstChunk(true);
    await expect(send(replay.base, "/wacz/org/acme/2026-11/a_c1.wacz")).rejects.toThrow();
  });

  it("受け手が去ったら、保管庫への要求も止める", async () => {
    store.delay(5_000);
    const patient = await startReplay(store.bucketUrl, { upstreamTimeoutMs: 10_000 });
    try {
      const url = new URL(patient.base);
      const request = http.request({
        host: url.hostname,
        port: url.port,
        path: "/wacz/org/acme/2026-11/a_c1.wacz",
        agent: false,
      });
      request.on("error", () => undefined);
      request.end();
      await expect.poll(() => store.requests.length).toBe(1);
      request.destroy();
      await expect.poll(() => store.requests[0]!.closedEarly, { timeout: 2_000 }).toBe(true);
    } finally {
      await patient.close();
    }
  });
});

describe("名前の引き方", () => {
  it("名前は要求ごとに IPv4 で引く", async () => {
    await send(replay.base, "/wacz/org/acme/2026-11/a_c1.wacz");
    await send(replay.base, "/wacz/org/acme/2026-11/a_c1.wacz");
    expect(replay.dns.calls).toHaveLength(2);
    expect(
      replay.dns.calls.every((call) => call.hostname === STORE_HOST && call.family === 4),
    ).toBe(true);
  });

  it("保管庫のほかへは何も取りに行かない", async () => {
    for (const path of [
      "/",
      "/sw.js",
      "/__version",
      "/ruffle/ruffle.js",
      "/wacz/org/acme/2026-11/a_c1.wacz",
      "/wacz/http://other-site.test/x",
      "/q/org/a/crawls/b/r1/pages?url=http://other-site.test/",
    ]) {
      await send(replay.base, path);
    }
    expect(new Set(replay.dns.calls.map((call) => call.hostname))).toEqual(new Set([STORE_HOST]));
    expect(store.requests.every((seen) => seen.url.startsWith(`/${BUCKET}/`))).toBe(true);
  });
});
