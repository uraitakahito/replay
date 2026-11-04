import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupTemporaryDirectories } from "./helpers/files.js";
import { corsHeadersOf, send } from "./helpers/net.js";
import type { TestReplay } from "./helpers/replay.js";
import { startReplay } from "./helpers/replay.js";
import type { StandInStore } from "./helpers/store.js";
import { BUCKET, startStore } from "./helpers/store.js";

const DIR = "org/acme/crawls/3f2a/r1";

/** 保管庫の <置き場>/pages.json に置く合本の頁 */
const pagesJson = (rows: readonly Record<string, unknown>[]) =>
  JSON.stringify({ version: 1, crawlId: "3f2a", rev: 1, pages: rows });

const HUB = {
  id: "hub",
  url: "http://site.test/hub",
  ts: "2026-11-05T01:00:00.000Z",
  title: "hub",
  filename: "hub.wacz",
  depth: 0,
  stage: null,
  keys: ["http://site.test/hub"],
};
const LEAF = {
  id: "leaf",
  url: "http://site.test/hub/leaf",
  ts: "2026-11-05T01:00:01.000Z",
  title: "leaf",
  filename: "leaf.wacz",
  depth: 1,
  stage: null,
  keys: ["http://site.test/hub/leaf"],
};
const HUB_SNAPSHOT = {
  id: "hub-after-load",
  url: "urn:browserhive:snapshot:after-load:http://site.test/hub",
  ts: "2026-11-05T01:00:02.000Z",
  title: "hub",
  filename: "hub.wacz",
  depth: 0,
  stage: "after-load",
  keys: [],
};

const rowsFor = (count: number) =>
  Array.from({ length: count }, (_, n) => ({
    ...LEAF,
    id: `p${String(n).padStart(3, "0")}`,
    url: `http://site.test/p/${String(n)}`,
    keys: [`http://site.test/p/${String(n)}`],
  }));

let store: StandInStore;
let replay: TestReplay;

beforeAll(async () => {
  store = await startStore();
  replay = await startReplay(store.bucketUrl, { upstreamTimeoutMs: 300, pagesCacheEntries: 2 });
});

afterAll(async () => {
  await replay.close();
  await store.close();
  cleanupTemporaryDirectories();
});

beforeEach(() => {
  store.put(`${DIR}/pages.json`, pagesJson([LEAF, HUB_SNAPSHOT, HUB]), "application/json");
});

afterEach(() => {
  store.requests.length = 0;
  store.delay(0);
  store.answerWith(undefined);
});

/** 毎回ちがう置き場 (手元に置いた物に当たらないように) */
let revision = 100;
const freshDir = () => {
  revision += 1;
  return `org/acme/crawls/3f2a/r${String(revision)}`;
};

describe("/q/<置き場>/pages の答え", () => {
  it("?url= は keys が同じ行を先に、問いで始まる行を後に、replay の読む欄で返す", async () => {
    const res = await send(
      replay.base,
      `/q/${DIR}/pages?url=http%3A%2F%2Fsite.test%2Fhub&pageSize=25`,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString("utf8"))).toEqual({
      items: [
        { id: "hub", url: "http://site.test/hub", ts: HUB.ts, title: "hub", filename: "hub.wacz" },
        {
          id: "leaf",
          url: "http://site.test/hub/leaf",
          ts: LEAF.ts,
          title: "leaf",
          filename: "leaf.wacz",
        },
      ],
      total: 2,
    });
  });

  it("問いが無ければ全部の行を深さ → 時刻の順に返す（写しの行も）", async () => {
    const res = await send(replay.base, `/q/${DIR}/pages`);
    const answer = JSON.parse(res.body.toString("utf8")) as {
      items: { id: string }[];
      total: number;
    };
    expect(answer.items.map((item) => item.id)).toEqual(["hub", "hub-after-load", "leaf"]);
    expect(answer.total).toBe(3);
  });

  it("?search= は url か title が語を含む行（大小を区別しない）", async () => {
    const res = await send(replay.base, `/q/${DIR}/pages?search=LEAF&page=1&pageSize=25`);
    const answer = JSON.parse(res.body.toString("utf8")) as { items: { id: string }[] };
    expect(answer.items.map((item) => item.id)).toEqual(["leaf"]);
  });

  it("application/json; charset=utf-8 と Content-Length を付け、CORS の header は付けない", async () => {
    const res = await send(replay.base, `/q/${DIR}/pages?url=http://site.test/hub`, {
      headers: { origin: "https://other-site.test" },
    });
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["content-length"]).toBe(String(res.body.length));
    expect(corsHeadersOf(res.headers)).toEqual([]);
  });

  it("HEAD は header だけを返す", async () => {
    const res = await send(replay.base, `/q/${DIR}/pages`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(Number(res.headers["content-length"])).toBeGreaterThan(0);
    expect(res.body.length).toBe(0);
  });

  it("POST は 405", async () => {
    const res = await send(replay.base, `/q/${DIR}/pages`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("/q/ の page と pageSize", () => {
  it("pageSize の既定は 25、上限は 100", async () => {
    const dir = freshDir();
    store.put(`${dir}/pages.json`, pagesJson(rowsFor(150)), "application/json");
    const byDefault = JSON.parse((await send(replay.base, `/q/${dir}/pages`)).body.toString()) as {
      items: unknown[];
      total: number;
    };
    expect(byDefault.items).toHaveLength(25);
    expect(byDefault.total).toBe(150);
    const capped = JSON.parse(
      (await send(replay.base, `/q/${dir}/pages?pageSize=500`)).body.toString(),
    ) as { items: unknown[] };
    expect(capped.items).toHaveLength(100);
  });

  it("page は 1 から数える", async () => {
    const dir = freshDir();
    store.put(`${dir}/pages.json`, pagesJson(rowsFor(5)), "application/json");
    const res = await send(replay.base, `/q/${dir}/pages?page=2&pageSize=2`);
    const answer = JSON.parse(res.body.toString()) as { items: { id: string }[]; total: number };
    expect(answer.items.map((item) => item.id)).toEqual(["p002", "p003"]);
    expect(answer.total).toBe(5);
  });

  it.each(["page=0", "page=-1", "page=1.5", "pageSize=abc", "pageSize=0", "page="])(
    "%s は 400",
    async (query) => {
      const res = await send(replay.base, `/q/${DIR}/pages?${query}`);
      expect(res.status).toBe(400);
    },
  );
});

describe("/q/ の置き場の形", () => {
  it.each([
    "org/acme/crawls/3f2a/r0",
    "org/acme/crawls/3f2a/r01",
    "org/acme/crawls/3f2a/1",
    "org/acme/crawls/3f2a",
    "org/acme/3f2a/r1",
    "orgs/acme/crawls/3f2a/r1",
    "org/acme/crawls/3f2a/r1/extra",
    "org//crawls/3f2a/r1",
    "org/../crawls/3f2a/r1",
    "org/%2e%2e/crawls/3f2a/r1",
    "org/a%2Fb/crawls/3f2a/r1",
    "org/acme/crawls/%ZZ/r1",
  ])("/q/%s/pages は 400 で、保管庫を読まない", async (dir) => {
    const res = await send(replay.base, `/q/${dir}/pages`);
    expect(res.status).toBe(400);
    expect(store.requests).toEqual([]);
  });

  it("<置き場>/pages でない path は 404", async () => {
    const res = await send(replay.base, `/q/${DIR}/replay.json`);
    expect(res.status).toBe(404);
    expect(store.requests).toEqual([]);
  });
});

describe("/q/ が読む pages.json", () => {
  it("S3_BUCKET_URL の下の <置き場>/pages.json を読む", async () => {
    const dir = freshDir();
    store.put(`${dir}/pages.json`, pagesJson([HUB]), "application/json");
    await send(replay.base, `/q/${dir}/pages`);
    expect(store.requests.map((seen) => `${seen.method} ${seen.url}`)).toEqual([
      `GET /${BUCKET}/${dir}/pages.json`,
    ]);
  });

  it("読んだ物を手元に置き、同じ置き場の問いでは読みに行かない（同時の問いも 1 本）", async () => {
    const dir = freshDir();
    store.put(`${dir}/pages.json`, pagesJson([HUB]), "application/json");
    await Promise.all([
      send(replay.base, `/q/${dir}/pages?url=http://site.test/hub`),
      send(replay.base, `/q/${dir}/pages?url=http://site.test/hub`),
    ]);
    await send(replay.base, `/q/${dir}/pages?search=hub`);
    expect(store.requests).toHaveLength(1);
  });

  it("置く数を超えたら、長く使っていない置き場から捨てる", async () => {
    const [a, b, c] = [freshDir(), freshDir(), freshDir()];
    for (const dir of [a, b, c]) {
      store.put(`${dir}/pages.json`, pagesJson([HUB]), "application/json");
    }
    await send(replay.base, `/q/${a}/pages`);
    await send(replay.base, `/q/${b}/pages`);
    await send(replay.base, `/q/${a}/pages`); // a を使い直す: 次に捨てるのは b
    await send(replay.base, `/q/${c}/pages`);
    await send(replay.base, `/q/${a}/pages`);
    await send(replay.base, `/q/${b}/pages`);
    // url は /bucket/org/acme/crawls/3f2a/r<版>/pages.json
    const reads = store.requests.map((seen) => seen.url.split("/")[6]);
    expect(reads).toEqual([a, b, c, b].map((dir) => dir.split("/")[4]));
  });

  it("pages.json が無ければ 404（無かったことは覚えず、置かれた後は答える）", async () => {
    const dir = freshDir();
    const missing = await send(replay.base, `/q/${dir}/pages`);
    expect(missing.status).toBe(404);
    expect(missing.headers["content-type"]).toBe("application/json; charset=utf-8");
    store.put(`${dir}/pages.json`, pagesJson([HUB]), "application/json");
    expect((await send(replay.base, `/q/${dir}/pages`)).status).toBe(200);
  });

  it("保管庫が 404 のほかで断ったら 502", async () => {
    store.answerWith(403);
    expect((await send(replay.base, `/q/${freshDir()}/pages`)).status).toBe(502);
  });

  it.each([
    ["JSON でない", "{"],
    ["版が 1 でない", JSON.stringify({ version: 2, pages: [] })],
    ["行の形が違う", JSON.stringify({ version: 1, pages: [{ id: 1 }] })],
  ])("pages.json が%s物なら 502", async (_, body) => {
    const dir = freshDir();
    store.put(`${dir}/pages.json`, body, "application/json");
    expect((await send(replay.base, `/q/${dir}/pages`)).status).toBe(502);
  });

  it("保管庫が答えないまま時間が切れたら 504", async () => {
    store.delay(5_000);
    expect((await send(replay.base, `/q/${freshDir()}/pages`)).status).toBe(504);
  });
});
