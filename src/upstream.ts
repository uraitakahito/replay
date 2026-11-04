/**
 * 保管庫へ要求を 1 本送る。`/wacz/` の中継と `/q/` の pages.json の読みが使う。
 *
 * - 名前は要求ごとに引く (接続を使い回さない)。nginx は `resolver … valid=10s` で、作り直した
 *   保管庫の新しい IP を 10 秒のうちに拾っていた。ここは毎回引くので、それより早い。
 * - 引くのは IPv4 だけ。Apple Container の DNS は AAAA を先に答え、VM の間に v6 の道が無い
 *   (nginx の `ipv6=off`・BrowserHive の `--dns-result-order=ipv4first` と同じ理由)。
 * - 届かない (名前が無い・繋がらない) は "unreachable"、黙ったままは "timeout"。呼び手が
 *   502 と 504 に分ける。
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { Upstream } from "./config.js";

export type UpstreamFailure = "unreachable" | "timeout";

export class UpstreamError extends Error {
  override name = "UpstreamError";
  readonly kind: UpstreamFailure;

  constructor(kind: UpstreamFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
  }
}

export interface UpstreamOptions {
  /** 名前の引き方。Node が family 4 を付けて呼ぶ (sendUpstream)。試験は代役を差し込む */
  readonly lookup: LookupFunction;
  /** 答えの header が届くまでと、本文の途中で黙っている間の上限 (ミリ秒) */
  readonly timeoutMs: number;
}

/** OS の resolver (getaddrinfo)。/etc/hosts も読む。 */
export const systemLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, options, callback);
};

const asUpstreamError = (error: Error): UpstreamError => {
  if (error instanceof UpstreamError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  return new UpstreamError(code === "ETIMEDOUT" ? "timeout" : "unreachable", error.message, {
    cause: error,
  });
};

export interface UpstreamRequest {
  readonly method: string;
  /** 符号にした path と query。保管庫へは書いたとおりに届く */
  readonly path: string;
  readonly headers: http.OutgoingHttpHeaders;
}

export interface UpstreamExchange {
  /** 送った要求。呼び手が途中で止めるときに destroy する */
  readonly request: http.ClientRequest;
  /** 答えの header が届いたら resolve。届く前の失敗は UpstreamError で reject */
  readonly response: Promise<http.IncomingMessage>;
}

/**
 * 保管庫へ 1 本送る。本文の途中の失敗は、答えの stream の error として出る (呼び手の pipeline が
 * 受ける)。
 */
export const sendUpstream = (
  upstream: Upstream,
  init: UpstreamRequest,
  options: UpstreamOptions,
): UpstreamExchange => {
  const client = upstream.protocol === "https:" ? https : http;
  const request = client.request({
    protocol: upstream.protocol,
    host: upstream.hostname,
    port: upstream.port,
    method: init.method,
    path: init.path,
    headers: init.headers,
    // 接続を使い回さない。名前を要求ごとに引き、作り直した保管庫の古い接続に送らないため
    agent: false,
    // IPv4 だけで引く。Node は lookup を family 4 で呼び、v4 と v6 を並べて試す形 (autoSelectFamily)
    // にもしない
    family: 4,
    lookup: options.lookup,
  });
  const response = new Promise<http.IncomingMessage>((resolve, reject) => {
    let answer: http.IncomingMessage | undefined;
    const timedOut = () => {
      const error = new UpstreamError(
        "timeout",
        `the store went silent for ${String(options.timeoutMs)} ms`,
      );
      // 本文の途中なら、読み手にも時間切れとして届ける
      answer?.destroy(error);
      request.destroy(error);
    };
    // header までの上限 (名前を引く間も数える) と、socket が黙っている間の上限
    const timer = setTimeout(timedOut, options.timeoutMs);
    request.setTimeout(options.timeoutMs, timedOut);
    request.on("response", (res) => {
      clearTimeout(timer);
      answer = res;
      resolve(res);
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(asUpstreamError(error));
    });
    // 呼び手が答えの前に destroy() したとき (error を出さずに閉じる) も、待ちを終える
    request.on("close", () => {
      clearTimeout(timer);
      reject(new UpstreamError("unreachable", "the request was closed before the store answered"));
    });
  });
  request.end();
  return { request, response };
};
