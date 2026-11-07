/**
 * 試験の中で Node server を立てる。127.0.0.1 の空いた口で待ち、名前は代役が引く
 * (STORE_HOST だけが 127.0.0.1 に答える)。
 */
import { parseBucketUrl } from "../../src/config.js";
import type { ListenAddresses, ViewerServer, ViewerServerOptions } from "../../src/server.js";
import { createViewerServer } from "../../src/server.js";
import { loadStaticFiles } from "../../src/static.js";
import { makeStaticDirectory } from "./files.js";
import type { StubLookup } from "./net.js";
import { stubLookup } from "./net.js";
import { STORE_HOST } from "./store.js";

export interface TestViewer {
  readonly server: ViewerServer;
  readonly addresses: ListenAddresses;
  /** http://127.0.0.1:<平文の口> */
  readonly base: string;
  readonly dns: StubLookup;
  /** logError に出た行 */
  readonly errors: string[];
  close(): Promise<void>;
}

export const startViewer = async (
  bucketUrl: string,
  options: Partial<Omit<ViewerServerOptions, "upstream" | "staticFiles">> = {},
): Promise<TestViewer> => {
  const dns = stubLookup({ [STORE_HOST]: "127.0.0.1" });
  const errors: string[] = [];
  const server = createViewerServer({
    upstream: parseBucketUrl(bucketUrl),
    staticFiles: loadStaticFiles(makeStaticDirectory()),
    lookup: dns.lookup,
    log: () => undefined,
    logError: (line) => errors.push(line),
    ...options,
  });
  const addresses = await server.listen({ host: "127.0.0.1", plainPort: 0, securePort: 0 });
  return {
    server,
    addresses,
    base: `http://127.0.0.1:${String(addresses.plain.port)}`,
    dns,
    errors,
    close: () => server.close(0),
  };
};
