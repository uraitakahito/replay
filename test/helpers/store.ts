/**
 * 保管庫 (S3 互換の bucket 1 つ) の代役。試験の中で node:http で立てる。
 *
 * SeaweedFS が匿名の GET・HEAD に答える形を真似る: path を 1 度だけ解いて鍵にする・ETag・
 * Range (1 つの範囲)・If-Range・If-None-Match・無い鍵は 404。受けた要求は全部記録する。
 */
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export const BUCKET = "bucket";
/** 試験の lookup が 127.0.0.1 に向ける名前 */
export const STORE_HOST = "store.test";

export interface StoredObject {
  body: Buffer;
  contentType: string;
  /** 答えに足す header (接続ごとの header を外すかを見る試験が使う) */
  extraHeaders?: http.OutgoingHttpHeaders;
}

export interface SeenRequest {
  readonly method: string;
  /** 要求の行の path と query (符号のまま) */
  readonly url: string;
  /** bucket の後ろを 1 度解いた鍵 */
  readonly key: string;
  readonly headers: http.IncomingHttpHeaders;
  /** 代役が答え終える前に、送り手が接続を切ったか */
  closedEarly: boolean;
}

export interface StandInStore {
  readonly port: number;
  /** S3_BUCKET_URL に渡す形 (名前は STORE_HOST) */
  readonly bucketUrl: string;
  readonly requests: SeenRequest[];
  put(
    key: string,
    body: Buffer | string,
    contentType?: string,
    extraHeaders?: http.OutgoingHttpHeaders,
  ): void;
  remove(key: string): void;
  /** 次からの要求に、header を返す前に待たせる (ミリ秒)。0 で戻す */
  delay(ms: number): void;
  /** 次からの要求に、header と最初の 16 バイトだけ返して黙らせる */
  stallAfterFirstChunk(on: boolean): void;
  /** 次からの要求に、header と最初の 16 バイトを返してから接続を切らせる */
  cutAfterFirstChunk(on: boolean): void;
  /** 次からの要求に、この status で答えさせる (undefined で戻す) */
  answerWith(status: number | undefined): void;
  close(): Promise<void>;
}

const etagOf = (body: Buffer) => `"${createHash("md5").update(body).digest("hex")}"`;

/** `bytes=a-b`・`bytes=a-`・`bytes=-n` の 1 つの範囲。読めなければ undefined、外れたら "unsatisfiable" */
const parseRange = (
  header: string,
  size: number,
): [number, number] | "unsatisfiable" | undefined => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (match === null) return undefined;
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return undefined;
  if (from === "") {
    const length = Math.min(Number(to), size);
    return length === 0 ? "unsatisfiable" : [size - length, size - 1];
  }
  const start = Number(from);
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  return start >= size || end < start ? "unsatisfiable" : [start, end];
};

export const startStore = async (): Promise<StandInStore> => {
  const objects = new Map<string, StoredObject>();
  const requests: SeenRequest[] = [];
  let delayMs = 0;
  let stall = false;
  let cut = false;
  let forcedStatus: number | undefined;
  const timers = new Set<NodeJS.Timeout>();

  const answer = (req: http.IncomingMessage, res: http.ServerResponse, seen: SeenRequest) => {
    if (forcedStatus !== undefined) {
      res.writeHead(forcedStatus, { "content-type": "application/xml" });
      res.end(`<Error><Code>Forced</Code></Error>`);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    const object = objects.get(seen.key);
    if (object === undefined) {
      const body = `<Error><Code>NoSuchKey</Code><Key>${seen.key}</Key></Error>`;
      res.writeHead(404, {
        "content-type": "application/xml",
        "content-length": Buffer.byteLength(body),
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    const etag = etagOf(object.body);
    const common = {
      ...object.extraHeaders,
      etag,
      "accept-ranges": "bytes",
      "content-type": object.contentType,
    };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { etag });
      res.end();
      return;
    }
    const size = object.body.length;
    const ifRange = req.headers["if-range"];
    const rangeHeader = req.headers.range;
    const range =
      rangeHeader !== undefined && (ifRange === undefined || ifRange === etag)
        ? parseRange(rangeHeader, size)
        : undefined;
    if (range === "unsatisfiable") {
      res.writeHead(416, { ...common, "content-range": `bytes */${String(size)}` });
      res.end();
      return;
    }
    const [start, end] = range ?? [0, size - 1];
    const body = object.body.subarray(start, end + 1);
    const headers: http.OutgoingHttpHeaders = { ...common };
    if (object.extraHeaders?.["transfer-encoding"] === undefined) {
      headers["content-length"] = body.length;
    }
    if (range !== undefined)
      headers["content-range"] = `bytes ${String(start)}-${String(end)}/${String(size)}`;
    res.writeHead(range === undefined ? 200 : 206, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    if (stall || cut) {
      res.write(body.subarray(0, 16));
      if (cut) setImmediate(() => res.socket?.destroy());
      return;
    }
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const path = url.split("?")[0] ?? "";
    const prefix = `/${BUCKET}/`;
    let key: string;
    try {
      key = path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : "";
    } catch {
      key = "";
    }
    const seen: SeenRequest = {
      method: req.method ?? "",
      url,
      key,
      headers: req.headers,
      closedEarly: false,
    };
    requests.push(seen);
    res.once("close", () => {
      if (!res.writableFinished) seen.closedEarly = true;
    });
    if (!path.startsWith(prefix)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!res.destroyed) answer(req, res, seen);
      }, delayMs);
      timers.add(timer);
      return;
    }
    answer(req, res, seen);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    bucketUrl: `http://${STORE_HOST}:${String(port)}/${BUCKET}`,
    requests,
    put(key, body, contentType = "application/wacz+zip", extraHeaders) {
      objects.set(key, {
        body: typeof body === "string" ? Buffer.from(body, "utf8") : body,
        contentType,
        ...(extraHeaders === undefined ? {} : { extraHeaders }),
      });
    },
    remove(key) {
      objects.delete(key);
    },
    delay(ms) {
      delayMs = ms;
    },
    stallAfterFirstChunk(on) {
      stall = on;
    },
    cutAfterFirstChunk(on) {
      cut = on;
    },
    answerWith(status) {
      forcedStatus = status;
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
