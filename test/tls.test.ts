import http2 from "node:http2";
import https from "node:https";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SelfSignedCertificate } from "./helpers/files.js";
import { cleanupTemporaryDirectories, makeSelfSignedCertificate } from "./helpers/files.js";
import { send } from "./helpers/net.js";
import type { TestViewer } from "./helpers/viewer.js";
import { startViewer } from "./helpers/viewer.js";
import type { StandInStore } from "./helpers/store.js";
import { startStore } from "./helpers/store.js";

let certificate: SelfSignedCertificate;
let store: StandInStore;
let viewer: TestViewer;
let secureOrigin: string;
/** server が出した要求の記録の行 */
const logLines: string[] = [];

const WACZ = Buffer.from(Array.from({ length: 4096 }, (_, n) => n % 253));

beforeAll(async () => {
  certificate = makeSelfSignedCertificate();
  store = await startStore();
  // 接続ごとの header を返す保管庫 (HTTP/2 の答えに載せると Node が投げる)。Content-Length の
  // 代わりに chunked で送る
  store.put("org/acme/a.wacz", WACZ, "application/wacz+zip", {
    connection: "keep-alive",
    "keep-alive": "timeout=5",
    "transfer-encoding": "chunked",
  });
  store.put(
    "org/acme/crawls/c1/r1/pages.json",
    JSON.stringify({
      version: 1,
      pages: [
        { id: "a", url: "http://site.test/", filename: "a.wacz", keys: ["http://site.test/"] },
      ],
    }),
    "application/json",
  );
  viewer = await startViewer(store.bucketUrl, {
    tls: { cert: certificate.cert, key: certificate.key },
    log: (line) => logLines.push(line),
  });
  secureOrigin = `https://localhost:${String(viewer.addresses.secure!.port)}`;
});

afterAll(async () => {
  await viewer.close();
  await store.close();
  cleanupTemporaryDirectories();
});

interface Http2Answer {
  readonly status: number;
  readonly headers: http2.IncomingHttpHeaders;
  readonly body: Buffer;
  readonly protocol: string | undefined;
}

const getOverHttp2 = (
  path: string,
  headers: http2.OutgoingHttpHeaders = {},
): Promise<Http2Answer> =>
  new Promise((resolve, reject) => {
    const session = http2.connect(secureOrigin, { ca: certificate.cert });
    session.on("error", reject);
    const stream = session.request({ ":path": path, ...headers });
    let answerHeaders: http2.IncomingHttpHeaders = {};
    const chunks: Buffer[] = [];
    stream.on("response", (received) => {
      answerHeaders = received;
    });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => {
      const protocol = session.alpnProtocol;
      session.close();
      resolve({
        status: Number(answerHeaders[":status"]),
        headers: answerHeaders,
        body: Buffer.concat(chunks),
        protocol,
      });
    });
    stream.end();
  });

describe("TLS（TLS_CERT と TLS_KEY が揃ったとき）", () => {
  it("TLS の口で HTTP/2 で答える", async () => {
    const answer = await getOverHttp2("/");
    expect(answer.protocol).toBe("h2");
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("HTTP/2 の要求の記録にも相手の address が出る（nginx の $remote_addr と同じ）", async () => {
    const answer = await getOverHttp2("/__version?log-remote");
    expect(answer.status).toBe(200);
    // 記録は答えを閉じた時に書く。届くまで少し待つ
    let line: string | undefined;
    for (let tries = 0; tries < 50 && line === undefined; tries += 1) {
      line = logLines.find((one) => one.includes("/__version?log-remote"));
      if (line === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(line).toMatch(/^\S+ 127\.0\.0\.1 "GET \/__version\?log-remote HTTP\/2\.0" 200 /);
  });

  it("TLS の口は HTTP/1.1 でも答える", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = https.get(
        `${secureOrigin}/__version`,
        { ca: certificate.cert, agent: false },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      request.on("error", reject);
    });
    expect(status).toBe(200);
  });

  it("平文の口も開いたまま", async () => {
    const res = await send(viewer.base, "/__version");
    expect(res.status).toBe(200);
  });

  it("HTTP/2 でも /wacz/ を中継し、保管庫の接続ごとの header を外して返す", async () => {
    const answer = await getOverHttp2("/wacz/org/acme/a.wacz");
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("application/wacz+zip");
    expect(answer.headers.connection).toBeUndefined();
    expect(answer.headers["keep-alive"]).toBeUndefined();
    expect(answer.headers["transfer-encoding"]).toBeUndefined();
    expect(answer.body.equals(WACZ)).toBe(true);
  });

  it("HTTP/2 でも Range を渡して 206 を返す", async () => {
    const answer = await getOverHttp2("/wacz/org/acme/a.wacz", { range: "bytes=100-199" });
    expect(answer.status).toBe(206);
    expect(answer.headers["content-range"]).toBe("bytes 100-199/4096");
    expect(answer.body.equals(WACZ.subarray(100, 200))).toBe(true);
  });

  it("HTTP/2 でも /q/ に答える", async () => {
    const answer = await getOverHttp2("/q/org/acme/crawls/c1/r1/pages?url=http://site.test/");
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body.toString()) as unknown).toMatchObject({ total: 1 });
  });
});
