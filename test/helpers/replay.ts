/**
 * 試験の中で replay の server を立てる。127.0.0.1 の空いた口で待ち、名前は代役が引く
 * (STORE_HOST だけが 127.0.0.1 に答える)。
 */
import { parseBucketUrl } from "../../src/config.js";
import type { ListenAddresses, ReplayServer, ReplayServerOptions } from "../../src/server.js";
import { createReplayServer } from "../../src/server.js";
import { loadStaticFiles } from "../../src/static.js";
import { makeStaticDirectory } from "./files.js";
import type { StubLookup } from "./net.js";
import { stubLookup } from "./net.js";
import { STORE_HOST } from "./store.js";

export interface TestReplay {
  readonly server: ReplayServer;
  readonly addresses: ListenAddresses;
  /** http://127.0.0.1:<平文の口> */
  readonly base: string;
  readonly dns: StubLookup;
  /** logError に出た行 */
  readonly errors: string[];
  close(): Promise<void>;
}

export const startReplay = async (
  bucketUrl: string,
  options: Partial<Omit<ReplayServerOptions, "upstream" | "staticFiles">> = {},
): Promise<TestReplay> => {
  const dns = stubLookup({ [STORE_HOST]: "127.0.0.1" });
  const errors: string[] = [];
  const server = createReplayServer({
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
