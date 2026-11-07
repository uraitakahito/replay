import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ViewerProcess, RunOptions, RunningViewer } from "../src/run.js";
import { run } from "../src/run.js";
import {
  cleanupTemporaryDirectories,
  makeSelfSignedCertificate,
  makeStaticDirectory,
  writeTemporaryFile,
} from "./helpers/files.js";
import { send, stubLookup } from "./helpers/net.js";
import type { StandInStore } from "./helpers/store.js";
import { STORE_HOST, startStore } from "./helpers/store.js";

interface FakeProcess {
  readonly proc: ViewerProcess;
  readonly out: string[];
  readonly err: string[];
  readonly exits: number[];
  readonly signals: Map<string, () => void>;
  readonly privileges: string[];
}

const fakeProcess = (
  env: Record<string, string | undefined>,
  identity: { uid?: number; failToSwitch?: boolean } = {},
): FakeProcess => {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const signals = new Map<string, () => void>();
  const privileges: string[] = [];
  const proc: ViewerProcess = {
    env,
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    exit: (code: number) => {
      exits.push(code);
    },
    on: (signal, listener) => {
      signals.set(signal, listener);
    },
    getuid: () => identity.uid ?? 501,
    setgroups: (groups) => {
      privileges.push(`setgroups ${JSON.stringify(groups)}`);
    },
    setgid: (id) => {
      privileges.push(`setgid ${String(id)}`);
    },
    setuid: (id) => {
      if (identity.failToSwitch === true) throw new Error("EPERM, Operation not permitted");
      privileges.push(`setuid ${String(id)}`);
    },
  };
  return { proc, out, err, exits, signals, privileges };
};

let store: StandInStore;
let staticDir: string;
let resolvConf: string;
const running: RunningViewer[] = [];

beforeAll(async () => {
  store = await startStore();
  staticDir = makeStaticDirectory();
  resolvConf = writeTemporaryFile("resolv.conf", "nameserver 192.168.64.1\n");
});

afterEach(async () => {
  for (const viewer of running.splice(0)) await viewer.server.close(0);
  store.requests.length = 0;
  store.delay(0);
});

afterAll(async () => {
  await store.close();
  cleanupTemporaryDirectories();
});

const options = (overrides: Partial<RunOptions> = {}): RunOptions => ({
  host: "127.0.0.1",
  plainPort: 0,
  securePort: 0,
  staticDir,
  resolvConfPath: resolvConf,
  lookup: stubLookup({ [STORE_HOST]: "127.0.0.1" }).lookup,
  log: () => undefined,
  logError: () => undefined,
  ...overrides,
});

const start = async (fake: FakeProcess, overrides: Partial<RunOptions> = {}) => {
  const viewer = await run(fake.proc, options(overrides));
  if (viewer !== undefined) running.push(viewer);
  return viewer;
};

const baseOf = (viewer: RunningViewer) => `http://127.0.0.1:${String(viewer.addresses.plain.port)}`;

describe("起動の誤り（FATAL の 1 行と exit 1）", () => {
  it("S3_BUCKET_URL の形が違う", async () => {
    const fake = fakeProcess({ S3_BUCKET_URL: "http://store.test" });
    expect(await start(fake)).toBeUndefined();
    expect(fake.err).toEqual([
      "FATAL: S3_BUCKET_URL must be http(s)://<host>[:<port>]/<bucket>, got: http://store.test\n",
    ]);
    expect(fake.exits).toEqual([1]);
  });

  it("TLS_CERT と TLS_KEY の片方だけ", async () => {
    const fake = fakeProcess({ TLS_KEY: "/tls/k" });
    expect(await start(fake)).toBeUndefined();
    expect(fake.err).toEqual([
      "FATAL: TLS_CERT and TLS_KEY must be set together (only one was given)\n",
    ]);
    expect(fake.exits).toEqual([1]);
  });

  it("証明書が読めない", async () => {
    const fake = fakeProcess({ TLS_CERT: "/nonexistent/tls-cert", TLS_KEY: "/nonexistent/tls-k" });
    expect(await start(fake)).toBeUndefined();
    expect(fake.err).toEqual(["FATAL: cannot read /nonexistent/tls-cert\n"]);
    expect(fake.exits).toEqual([1]);
  });

  it("証明書と鍵が読めても、使えない中身なら起きない", async () => {
    const fake = fakeProcess({
      TLS_CERT: writeTemporaryFile("tls-cert", "not a certificate"),
      TLS_KEY: writeTemporaryFile("tls-k", "not a key"),
    });
    expect(await start(fake)).toBeUndefined();
    expect(fake.err).toHaveLength(1);
    expect(fake.err[0]).toMatch(/^FATAL: cannot use TLS_CERT and TLS_KEY: /);
    expect(fake.exits).toEqual([1]);
  });

  it("配る物が置き場に無い", async () => {
    const fake = fakeProcess({});
    expect(await start(fake, { staticDir: "/nonexistent/public" })).toBeUndefined();
    expect(fake.err).toEqual(["FATAL: cannot read /nonexistent/public/index.html\n"]);
    expect(fake.exits).toEqual([1]);
  });

  it("口を開けない", async () => {
    const taken = http.createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    try {
      const fake = fakeProcess({});
      const port = (taken.address() as AddressInfo).port;
      expect(await start(fake, { plainPort: port })).toBeUndefined();
      expect(fake.err[0]).toMatch(/^FATAL: cannot listen: .*EADDRINUSE/);
      expect(fake.exits).toEqual([1]);
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });
});

describe("起きてよいこと", () => {
  it("nameserver が無ければ WARN を出して起きる", async () => {
    const fake = fakeProcess({ S3_BUCKET_URL: store.bucketUrl });
    const viewer = await start(fake, {
      resolvConfPath: writeTemporaryFile("resolv.conf", "search crawler-storage\n"),
    });
    expect(viewer).toBeDefined();
    expect(fake.err).toEqual([
      "WARN: no nameserver in /etc/resolv.conf; /wacz/ will not resolve\n",
    ]);
    expect(fake.exits).toEqual([]);
    expect((await send(baseOf(viewer!), "/")).status).toBe(200);
  });

  it("保管庫の名前が引けなくても起き、/ は 200・/wacz/ は 502", async () => {
    const fake = fakeProcess({});
    const viewer = await start(fake, { lookup: stubLookup({}).lookup });
    expect(fake.exits).toEqual([]);
    expect(fake.out.join("")).toContain("http://seaweedfs.crawler-storage:8333/browserhive");
    expect((await send(baseOf(viewer!), "/")).status).toBe(200);
    expect((await send(baseOf(viewer!), "/wacz/x")).status).toBe(502);
  });

  it("TLS の 2 つが揃えば、平文の口に加えて TLS の口も開く", async () => {
    const certificate = makeSelfSignedCertificate();
    const fake = fakeProcess({ TLS_CERT: certificate.certPath, TLS_KEY: certificate.keyPath });
    const viewer = await start(fake);
    expect(viewer?.addresses.secure).toBeDefined();
    expect((await send(baseOf(viewer!), "/__version")).status).toBe(200);
  });

  it("TLS が無ければ平文の口だけ", async () => {
    const viewer = await start(fakeProcess({}));
    expect(viewer?.addresses.secure).toBeUndefined();
  });
});

describe("止め方（PID 1 で受ける合図）", () => {
  it.each(["SIGTERM", "SIGINT"])(
    "%s で、走っている要求を終えてから閉じて exit 0",
    async (signal) => {
      store.put("slow.wacz", "slow");
      store.delay(200);
      const fake = fakeProcess({ S3_BUCKET_URL: store.bucketUrl });
      const viewer = await start(fake, { shutdownGraceMs: 2_000 });
      const base = baseOf(viewer!);
      const inFlight = send(base, "/wacz/slow.wacz");
      await expect.poll(() => store.requests.some((seen) => seen.key === "slow.wacz")).toBe(true);
      fake.signals.get(signal)!();
      expect((await inFlight).status).toBe(200);
      await expect.poll(() => fake.exits).toEqual([0]);
      await expect(send(base, "/")).rejects.toThrow();
    },
  );
});

describe("root から降りる", () => {
  it("root で起きたら、口を開いた後に node の利用者へ降りる", async () => {
    const fake = fakeProcess({}, { uid: 0 });
    const viewer = await start(fake);
    expect(viewer).toBeDefined();
    expect(fake.privileges).toEqual(["setgroups []", "setgid node", "setuid node"]);
    expect(fake.out.join("")).toContain("now serving as node");
  });

  it("root でなければ降りない", async () => {
    const fake = fakeProcess({}, { uid: 1000 });
    await start(fake);
    expect(fake.privileges).toEqual([]);
  });

  it("降りられなければ WARN を出して、root のまま続ける", async () => {
    const fake = fakeProcess({}, { uid: 0, failToSwitch: true });
    const viewer = await start(fake);
    expect(viewer).toBeDefined();
    expect(fake.err).toEqual([
      "WARN: could not switch to the node user (EPERM, Operation not permitted); serving as root\n",
    ]);
    expect(fake.exits).toEqual([]);
  });
});
