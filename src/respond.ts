/**
 * 8080 (HTTP/1.1) と 443 (HTTP/2 の互換 API・HTTP/1.1) の両方で使う、要求と答えの形と、
 * 本文つきの答えを返す部品。
 */
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

/** http.IncomingMessage と http2.Http2ServerRequest の、ここで使う所 */
export interface ViewerRequest {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly httpVersion: string;
  readonly socket: { readonly remoteAddress?: string | undefined } | null;
}

/** http.ServerResponse と http2.Http2ServerResponse の、ここで使う所 */
export interface ViewerResponse extends NodeJS.WritableStream {
  statusCode: number;
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
  writeHead(statusCode: number, headers?: OutgoingHttpHeaders): this;
  destroy(error?: Error): this;
}

/** 本文を持つ答え。Content-Length を付け、HEAD には本文を送らない。CORS の header は付けない。 */
export const send = (
  req: ViewerRequest,
  res: ViewerResponse,
  status: number,
  contentType: string,
  body: Buffer | string,
  headers: OutgoingHttpHeaders = {},
): void => {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.writeHead(status, {
    ...headers,
    "content-type": contentType,
    "content-length": bytes.length,
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(bytes);
  }
};

export const sendText = (
  req: ViewerRequest,
  res: ViewerResponse,
  status: number,
  text: string,
  headers: OutgoingHttpHeaders = {},
): void => {
  send(req, res, status, "text/plain; charset=utf-8", `${text}\n`, headers);
};

export const sendJson = (
  req: ViewerRequest,
  res: ViewerResponse,
  status: number,
  value: unknown,
): void => {
  send(req, res, status, "application/json; charset=utf-8", JSON.stringify(value));
};

/**
 * 読むだけの口 (GET と HEAD)。ほかの method は 405 で断り、true を返す (呼び手はそこで終える)。
 * 保管庫へは GET と HEAD しか渡さない —— 匿名の書き込みは保管庫が断るが、断られる要求を
 * 中継しない。
 */
export const refuseUnlessRead = (req: ViewerRequest, res: ViewerResponse): boolean => {
  if (req.method === "GET" || req.method === "HEAD") return false;
  sendText(req, res, 405, "method not allowed", { allow: "GET, HEAD" });
  return true;
};
