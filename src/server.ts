/**
 * この repo の Node server。8080 で平文の HTTP/1.1 を常に、TLS の証明書と鍵があれば 443 で TLS
 * (HTTP/2 と HTTP/1.1) も待つ。どちらも同じ道筋で答える:
 *
 *   /wacz/<鍵>          保管庫へ中継 (proxy.ts)
 *   /q/<置き場>/pages    合本の頁の問い (pages-query.ts)
 *   / ほか 6 つ          ReplayWeb.page と image が焼いた物 (static.ts)
 *   それ以外            404
 *
 * CORS の header はどこにも付けない。保管庫のほかへは何も取りに行かない。
 */
import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo, LookupFunction, Socket } from "node:net";
import type { Upstream } from "./config.js";
import { BundleCache, answerPagesQuery, loadPagesJson } from "./pages-query.js";
import { proxyWacz } from "./proxy.js";
import type { ViewerRequest, ViewerResponse } from "./respond.js";
import { refuseUnlessRead, sendText } from "./respond.js";
import type { StaticFiles } from "./static.js";
import { serveStatic } from "./static.js";
import type { UpstreamOptions } from "./upstream.js";
import { systemLookup } from "./upstream.js";

/** nginx の proxy_connect_timeout・proxy_read_timeout の既定と同じ */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;
/** 手元に置く pages.json の数。開いているクロールは多くても数本 */
const DEFAULT_PAGES_CACHE_ENTRIES = 16;
/** 止めるときに、走っている要求を待つ長さ */
export const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;

export interface ViewerServerOptions {
  readonly upstream: Upstream;
  readonly staticFiles: StaticFiles;
  /** 揃っていれば 443 も開く */
  readonly tls?: { readonly cert: Buffer; readonly key: Buffer } | undefined;
  readonly lookup?: LookupFunction | undefined;
  readonly upstreamTimeoutMs?: number | undefined;
  readonly pagesCacheEntries?: number | undefined;
  /** 要求ごとの 1 行 (標準出力) */
  readonly log?: ((line: string) => void) | undefined;
  /** 保管庫に届かなかった・中で投げた (標準エラー) */
  readonly logError?: ((line: string) => void) | undefined;
}

export interface ListenAddresses {
  readonly plain: AddressInfo;
  readonly secure: AddressInfo | undefined;
}

export interface ViewerServer {
  /** 平文を開き、TLS があれば TLS も開く。どちらかが開けなければ、開いた物を閉じて投げる */
  listen(at: { host: string; plainPort: number; securePort: number }): Promise<ListenAddresses>;
  /** 待つのをやめ、走っている要求を graceMs まで待ってから、残った接続を切る */
  close(graceMs?: number): Promise<void>;
}

const listenOn = (server: http.Server | http2.Http2SecureServer, port: number, host: string) =>
  new Promise<AddressInfo>((resolve, reject) => {
    const failed = (error: Error) => {
      reject(error);
    };
    server.once("error", failed);
    server.listen(port, host, () => {
      server.off("error", failed);
      resolve(server.address() as AddressInfo);
    });
  });

const closeServer = (server: http.Server | http2.Http2SecureServer) =>
  new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => {
      resolve();
    });
  });

export const createViewerServer = (options: ViewerServerOptions): ViewerServer => {
  const log = options.log ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const logError = options.logError ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const upstreamOptions: UpstreamOptions = {
    lookup: options.lookup ?? systemLookup,
    timeoutMs: options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
  };
  const pagesCache = new BundleCache(
    options.pagesCacheEntries ?? DEFAULT_PAGES_CACHE_ENTRIES,
    (dir) => loadPagesJson(options.upstream, upstreamOptions, dir),
  );
  const context = { upstream: options.upstream, upstreamOptions, cache: pagesCache, logError };

  const route = async (req: ViewerRequest, res: ViewerResponse): Promise<void> => {
    const target = req.url ?? "";
    if (!target.startsWith("/")) {
      sendText(req, res, 400, "the request target must be a path");
      return;
    }
    const queryAt = target.indexOf("?");
    const path = queryAt === -1 ? target : target.slice(0, queryAt);
    const query = queryAt === -1 ? undefined : target.slice(queryAt + 1);
    if (path.startsWith("/wacz/")) {
      await proxyWacz(req, res, path.slice("/wacz/".length), query, context);
      return;
    }
    if (path.startsWith("/q/")) {
      await answerPagesQuery(req, res, path.slice("/q/".length), query, context);
      return;
    }
    const file = options.staticFiles.get(path);
    if (file === undefined) {
      sendText(req, res, 404, "not found");
      return;
    }
    if (refuseUnlessRead(req, res)) return;
    serveStatic(req, res, file);
  };

  let active = 0;
  const handle = (req: ViewerRequest, res: ViewerResponse): void => {
    const started = performance.now();
    // 相手の address は受けた時に取る。HTTP/2 では答えを閉じた後に socket を引くと、stream が閉じていて
    // 値が無い (記録が `-` になっていた)。nginx の $remote_addr は HTTP/2 でも出ていた
    const remote = req.socket?.remoteAddress ?? "-";
    active += 1;
    res.once("close", () => {
      active -= 1;
      const elapsed = (performance.now() - started).toFixed(1);
      log(
        `${new Date().toISOString()} ${remote} "${req.method ?? "-"} ${req.url ?? "-"} HTTP/${req.httpVersion}" ${String(res.statusCode)} ${elapsed}ms`,
      );
    });
    route(req, res).catch((error: unknown) => {
      logError(
        `${req.method ?? "-"} ${req.url ?? "-"}: ${(error as Error).stack ?? String(error)}`,
      );
      // 答えを書き始めていれば、接続を切って知らせる。書く前なら 500 (書けなければ切る)
      try {
        if (res.headersSent) throw error;
        sendText(req, res, 500, "internal error");
      } catch {
        res.destroy();
      }
    });
  };

  const plain = http.createServer(handle);
  const secure =
    options.tls === undefined
      ? undefined
      : http2.createSecureServer(
          { cert: options.tls.cert, key: options.tls.key, allowHTTP1: true },
          handle,
        );
  const secureSockets = new Set<Socket>();
  secure?.on("connection", (socket: Socket) => {
    secureSockets.add(socket);
    socket.once("close", () => secureSockets.delete(socket));
  });
  secure?.on("sessionError", (error: Error) => {
    logError(`HTTP/2 session: ${error.message}`);
  });

  return {
    async listen({ host, plainPort, securePort }) {
      const plainAddress = await listenOn(plain, plainPort, host);
      if (secure === undefined) return { plain: plainAddress, secure: undefined };
      try {
        return { plain: plainAddress, secure: await listenOn(secure, securePort, host) };
      } catch (error) {
        await closeServer(plain);
        throw error;
      }
    },
    async close(graceMs = DEFAULT_SHUTDOWN_GRACE_MS) {
      const closed = Promise.all([closeServer(plain), ...(secure ? [closeServer(secure)] : [])]);
      plain.closeIdleConnections();
      const deadline = Date.now() + graceMs;
      while (active > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      plain.closeAllConnections();
      for (const socket of secureSockets) socket.destroy();
      await closed;
    },
  };
};
