/**
 * `/wacz/<鍵>` を保管庫の `<S3_BUCKET_URL>/<鍵>` へ中継する。
 *
 * - 鍵は区切りごとに 1 度だけ解き、符号にし直して渡す (key-path.ts)。`.`・`..` は 400。
 * - query は書いたとおりに渡す。
 * - 要求の header は、範囲と条件の物だけを渡す (Range・If-Range・If-Match・If-None-Match・
 *   If-Modified-Since・If-Unmodified-Since)。Authorization は渡さない —— 匿名で読む。ブラウザが
 *   この口へ送った資格は、保管庫の資格ではない。Host は保管庫の host:port になる。
 * - 答えの status・header・本文はそのまま返す (206・Content-Range・Accept-Ranges・
 *   `application/wacz+zip`)。貯めない。wabac は WACZ 1 本を 60 回ほどの範囲の読みで開く。
 *   外すのは接続ごとの header だけ (HTTP/2 では送れず、HTTP/1.1 は Node が組み直す)。
 * - 保管庫に届かなければ 502、黙ったままなら 504。
 */
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { pipeline } from "node:stream/promises";
import type { Upstream } from "./config.js";
import { decodeKeyPath, encodeKeyPath } from "./key-path.js";
import type { ReplayRequest, ReplayResponse } from "./respond.js";
import { refuseUnlessRead, sendText } from "./respond.js";
import type { UpstreamOptions } from "./upstream.js";
import { UpstreamError, sendUpstream } from "./upstream.js";

/** 保管庫へ渡す要求の header (小文字)。ここに無い物は渡さない。 */
const FORWARDED_REQUEST_HEADERS: readonly string[] = [
  "range",
  "if-range",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
];

/** 接続ごとの header (RFC 9110 7.6.1 と、HTTP/2 が送らせない物)。答えから外す。 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "http2-settings",
]);

const forwardedHeaders = (headers: IncomingHttpHeaders): OutgoingHttpHeaders => {
  const forwarded: OutgoingHttpHeaders = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = headers[name];
    if (value !== undefined) forwarded[name] = value;
  }
  return forwarded;
};

/** 答えの header から、接続ごとの物と Connection が名指した物を外す。 */
const passedResponseHeaders = (headers: IncomingHttpHeaders): OutgoingHttpHeaders => {
  const named = new Set(
    (headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ""),
  );
  const passed: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name)) continue;
    passed[name] = value;
  }
  return passed;
};

export interface ProxyContext {
  readonly upstream: Upstream;
  readonly upstreamOptions: UpstreamOptions;
  readonly logError: (line: string) => void;
}

/**
 * @param rawKey   `/wacz/` の後ろの path (符号のまま)
 * @param rawQuery `?` の後ろ (無ければ undefined)
 */
export const proxyWacz = async (
  req: ReplayRequest,
  res: ReplayResponse,
  rawKey: string,
  rawQuery: string | undefined,
  context: ProxyContext,
): Promise<void> => {
  if (refuseUnlessRead(req, res)) return;
  const key = decodeKeyPath(rawKey);
  if (!key.ok) {
    sendText(req, res, 400, key.reason);
    return;
  }
  const method = req.method === "HEAD" ? "HEAD" : "GET";
  const query = rawQuery === undefined || rawQuery === "" ? "" : `?${rawQuery}`;
  const { request, response } = sendUpstream(
    context.upstream,
    {
      method,
      path: `${context.upstream.basePath}/${encodeKeyPath(key.segments)}${query}`,
      headers: forwardedHeaders(req.headers),
    },
    context.upstreamOptions,
  );
  // 受け手が先に去ったら、保管庫への要求も止める
  let gone = false;
  const abandon = () => {
    gone = true;
    request.destroy();
  };
  res.once("close", abandon);
  try {
    let answer;
    try {
      answer = await response;
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      if (gone) return;
      context.logError(`/wacz/${rawKey}: ${error.kind}: ${error.message}`);
      if (error.kind === "timeout") {
        sendText(req, res, 504, `upstream timed out: ${error.message}`);
      } else {
        sendText(req, res, 502, `upstream unreachable: ${error.message}`);
      }
      return;
    }
    res.writeHead(answer.statusCode ?? 502, passedResponseHeaders(answer.headers));
    if (method === "HEAD") {
      answer.resume();
      res.end();
      return;
    }
    try {
      await pipeline(answer, res);
    } catch (error) {
      // 本文の途中で保管庫が切れた・受け手が去った。status は送ってしまったので、接続を切って知らせる
      if (!res.writableEnded) {
        context.logError(`/wacz/${rawKey}: ${(error as Error).message}`);
      }
    }
  } finally {
    res.off("close", abandon);
  }
};
