/**
 * 試験の通信の道具: 名前の引き方の代役と、path を書いたとおりに送る HTTP の client。
 *
 * 名前は代役が答える (試験は実 DNS を引かない)。答えを決めていない名前は ENOTFOUND。
 */
import http from "node:http";
import type { LookupFunction } from "node:net";

export interface LookupCall {
  readonly hostname: string;
  readonly family: number | string | undefined;
  readonly all: boolean | undefined;
}

export interface StubLookup {
  readonly lookup: LookupFunction;
  readonly calls: LookupCall[];
}

export const stubLookup = (answers: Readonly<Record<string, string>>): StubLookup => {
  const calls: LookupCall[] = [];
  const lookup: LookupFunction = (hostname, options, callback) => {
    calls.push({ hostname, family: options.family, all: options.all });
    const address = answers[hostname];
    process.nextTick(() => {
      if (address === undefined) {
        const error: NodeJS.ErrnoException = Object.assign(
          new Error(`getaddrinfo ENOTFOUND ${hostname}`),
          { code: "ENOTFOUND", syscall: "getaddrinfo" },
        );
        callback(error, "");
      } else if (options.all === true) {
        callback(null, [{ address, family: 4 }]);
      } else {
        callback(null, address, 4);
      }
    });
  };
  return { lookup, calls };
};

export interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

/** path を正規化せずに送る (fetch は `..` を解いてしまう)。 */
export const send = (
  base: string,
  path: string,
  init: { method?: string; headers?: http.OutgoingHttpHeaders } = {},
): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const url = new URL(base);
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        path,
        method: init.method ?? "GET",
        headers: init.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });

/** 名前の付いた header (access-control-*) が答えに無いか */
export const corsHeadersOf = (headers: http.IncomingHttpHeaders): string[] =>
  Object.keys(headers).filter((name) => name.startsWith("access-control-"));
