/**
 * 起動の順。main.ts が process を渡して呼ぶ。試験は偽の process を渡す。
 *
 *   1. 環境変数 (config.ts)。誤りは `FATAL: …` を 1 行出して exit 1
 *   2. /etc/resolv.conf に nameserver が無ければ WARN を出して続ける
 *   3. 配る 6 つを読む。TLS の証明書と鍵が使えるかを見る
 *   4. 8080 (と 443) を開く
 *   5. root で起きていれば、node の利用者に降りる
 *   6. SIGTERM・SIGINT で、走っている要求を待ってから閉じて exit 0 (PID 1 で動くので、自分で受ける)
 *
 * 443 のために root で起き、開いた後に降りる (nginx の master と worker と同じ形)。node の実行ファイルに
 * CAP_NET_BIND_SERVICE を付ける形は取らない: file capability は、権限を絞った実行環境
 * (no-new-privileges・cap-drop) で exec そのものを EPERM にし、TLS を使わない起動まで道連れにする。
 * 降りる前に読むので、TLS の鍵は root だけが読める置き方でもよい。
 */
import { readFileSync } from "node:fs";
import type { LookupFunction } from "node:net";
import { createSecureContext } from "node:tls";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { RESOLVER_WARNING, StartupError, hasNameserver, loadConfig } from "./config.js";
import type { ListenAddresses, ViewerServer } from "./server.js";
import { DEFAULT_SHUTDOWN_GRACE_MS, createViewerServer } from "./server.js";
import type { StaticFiles } from "./static.js";
import { loadStaticFiles } from "./static.js";

/** process の、ここで使う所 */
export interface ViewerProcess {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  exit(code: number): void;
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  readonly getuid?: (() => number) | undefined;
  readonly setgroups?: ((groups: readonly (string | number)[]) => void) | undefined;
  readonly setgid?: ((id: string | number) => void) | undefined;
  readonly setuid?: ((id: string | number) => void) | undefined;
}

export interface RunOptions {
  /** 待つ address。既定は全部の IPv4 (nginx の `listen 8080` と同じ) */
  readonly host?: string;
  readonly plainPort?: number;
  readonly securePort?: number;
  /** 配る 6 つの置き場。既定は dist/ の隣の public/ (image の /app/public) */
  readonly staticDir?: string;
  readonly resolvConfPath?: string;
  /** root から降りる先 (node の image に在る利用者) */
  readonly runAs?: string;
  readonly lookup?: LookupFunction;
  readonly upstreamTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
  readonly log?: (line: string) => void;
  readonly logError?: (line: string) => void;
}

export interface RunningViewer {
  readonly server: ViewerServer;
  readonly addresses: ListenAddresses;
  /** SIGTERM を受けたときと同じ閉じ方 */
  readonly shutdown: () => Promise<void>;
}

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** root で動いていれば、runAs の利用者に降りる。降りられなければ WARN を出し、root のまま続ける。 */
const dropPrivileges = (proc: ViewerProcess, runAs: string): void => {
  if (proc.getuid?.() !== 0) return;
  if (proc.setgid === undefined || proc.setuid === undefined) return;
  try {
    proc.setgroups?.([]);
    proc.setgid(runAs);
    proc.setuid(runAs);
    proc.stdout.write(`replayweb-server: bound the ports as root, now serving as ${runAs}\n`);
  } catch (error) {
    proc.stderr.write(
      `WARN: could not switch to the ${runAs} user (${(error as Error).message}); serving as root\n`,
    );
  }
};

export const run = async (
  proc: ViewerProcess,
  options: RunOptions = {},
): Promise<RunningViewer | undefined> => {
  const fail = (message: string): undefined => {
    proc.stderr.write(`${message}\n`);
    proc.exit(1);
    return undefined;
  };

  let config: Config;
  let staticFiles: StaticFiles;
  try {
    config = loadConfig(proc.env, (path) => readFileSync(path));
    if (!hasNameserver(readText(options.resolvConfPath ?? "/etc/resolv.conf"))) {
      proc.stderr.write(`${RESOLVER_WARNING}\n`);
    }
    staticFiles = loadStaticFiles(
      options.staticDir ?? fileURLToPath(new URL("../public/", import.meta.url)),
    );
  } catch (error) {
    if (error instanceof StartupError) return fail(error.message);
    throw error;
  }
  if (config.tls !== undefined) {
    try {
      createSecureContext({ cert: config.tls.cert, key: config.tls.key });
    } catch (error) {
      return fail(`FATAL: cannot use TLS_CERT and TLS_KEY: ${(error as Error).message}`);
    }
  }

  const host = options.host ?? "0.0.0.0";
  const server = createViewerServer({
    upstream: config.upstream,
    staticFiles,
    tls: config.tls,
    lookup: options.lookup,
    upstreamTimeoutMs: options.upstreamTimeoutMs,
    log: options.log,
    logError: options.logError,
  });
  let addresses: ListenAddresses;
  try {
    addresses = await server.listen({
      host,
      plainPort: options.plainPort ?? 8080,
      securePort: options.securePort ?? 443,
    });
  } catch (error) {
    return fail(`FATAL: cannot listen: ${(error as Error).message}`);
  }
  dropPrivileges(proc, options.runAs ?? "node");

  const secure =
    addresses.secure === undefined ? "" : ` and https on ${String(addresses.secure.port)}`;
  proc.stdout.write(
    `replayweb-server: http on ${String(addresses.plain.port)}${secure}; /wacz/ and /q/ read ${config.bucketUrl}\n`,
  );

  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    closing ??= (async () => {
      await server.close(options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
      proc.exit(0);
    })();
    return closing;
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    proc.on(signal, () => {
      proc.stdout.write(`replayweb-server: ${signal}, closing\n`);
      void shutdown();
    });
  }
  return { server, addresses, shutdown };
};
