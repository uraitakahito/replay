import { describe, expect, it } from "vitest";
import {
  DEFAULT_S3_BUCKET_URL,
  RESOLVER_WARNING,
  StartupError,
  hasNameserver,
  loadConfig,
} from "../src/config.js";

const noFiles = (path: string): Buffer => {
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
};

const filesOf =
  (files: Readonly<Record<string, string>>) =>
  (path: string): Buffer => {
    const content = files[path];
    return content === undefined ? noFiles(path) : Buffer.from(content);
  };

/** 投げた StartupError の文言 (投げなければ失敗) */
const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(StartupError);
    return (error as Error).message;
  }
  throw new Error("起動を断らなかった");
};

const shapeMessage = (value: string) =>
  `FATAL: S3_BUCKET_URL must be http(s)://<host>[:<port>]/<bucket>, got: ${value}`;

describe("loadConfig（S3_BUCKET_URL）", () => {
  it("無いときは共有の保管庫を既定にする", () => {
    const config = loadConfig({}, noFiles);
    expect(DEFAULT_S3_BUCKET_URL).toBe("http://seaweedfs.crawler-storage:8333/browserhive");
    expect(config.bucketUrl).toBe(DEFAULT_S3_BUCKET_URL);
    expect(config.upstream).toEqual({
      protocol: "http:",
      hostname: "seaweedfs.crawler-storage",
      port: 8333,
      basePath: "/browserhive",
    });
    expect(config.tls).toBeUndefined();
  });

  it("空のときも既定にする", () => {
    expect(loadConfig({ S3_BUCKET_URL: "" }, noFiles).bucketUrl).toBe(DEFAULT_S3_BUCKET_URL);
  });

  it.each([
    [
      "http://store.test/bucket",
      { protocol: "http:", hostname: "store.test", port: 80, basePath: "/bucket" },
    ],
    [
      "https://store.test:9000/b",
      { protocol: "https:", hostname: "store.test", port: 9000, basePath: "/b" },
    ],
    [
      "http://store.test/bucket/",
      { protocol: "http:", hostname: "store.test", port: 80, basePath: "/bucket" },
    ],
    [
      "http://store.test/a/b",
      { protocol: "http:", hostname: "store.test", port: 80, basePath: "/a/b" },
    ],
    ["http://[::1]:8333/b", { protocol: "http:", hostname: "::1", port: 8333, basePath: "/b" }],
  ])("「%s」を受ける", (value, upstream) => {
    expect(loadConfig({ S3_BUCKET_URL: value }, noFiles).upstream).toEqual(upstream);
  });

  it.each([
    "http://store.test",
    "http://store.test/",
    "HTTP://store.test/b",
    "store.test/b",
    "ftp://store.test/b",
    "http:///b",
    "http://user:secret@store.test/b",
    "http://store.test/b?x=1",
    "http://store.test/b#f",
  ])("「%s」は entrypoint.sh と同じ文言で断る", (value) => {
    expect(refusal(() => loadConfig({ S3_BUCKET_URL: value }, noFiles))).toBe(shapeMessage(value));
  });
});

describe("loadConfig（TLS_CERT と TLS_KEY）", () => {
  it("両方が揃えば、両方を読む", () => {
    const config = loadConfig(
      { TLS_CERT: "/tls/c", TLS_KEY: "/tls/k" },
      filesOf({ "/tls/c": "CERT", "/tls/k": "KEY" }),
    );
    expect(config.tls?.cert.toString()).toBe("CERT");
    expect(config.tls?.key.toString()).toBe("KEY");
  });

  it.each([
    [{ TLS_CERT: "/tls/c" }],
    [{ TLS_KEY: "/tls/k" }],
    [{ TLS_CERT: "/tls/c", TLS_KEY: "" }],
  ])("片方だけ（%o）なら同じ文言で断る", (env) => {
    expect(refusal(() => loadConfig(env, filesOf({ "/tls/c": "C", "/tls/k": "K" })))).toBe(
      "FATAL: TLS_CERT and TLS_KEY must be set together (only one was given)",
    );
  });

  it("証明書が読めなければ、その path を名指して断る（鍵より先に見る）", () => {
    expect(refusal(() => loadConfig({ TLS_CERT: "/tls/c", TLS_KEY: "/tls/k" }, noFiles))).toBe(
      "FATAL: cannot read /tls/c",
    );
  });

  it("鍵が読めなければ、その path を名指して断る", () => {
    expect(
      refusal(() =>
        loadConfig({ TLS_CERT: "/tls/c", TLS_KEY: "/tls/k" }, filesOf({ "/tls/c": "C" })),
      ),
    ).toBe("FATAL: cannot read /tls/k");
  });

  it("S3_BUCKET_URL の形を TLS より先に見る", () => {
    expect(refusal(() => loadConfig({ S3_BUCKET_URL: "x", TLS_CERT: "/tls/c" }, noFiles))).toBe(
      shapeMessage("x"),
    );
  });
});

describe("hasNameserver（/etc/resolv.conf）", () => {
  it("nameserver の行があれば引ける", () => {
    expect(hasNameserver("search crawler-storage\nnameserver 192.168.64.1\n")).toBe(true);
  });

  it.each([undefined, "", "search x\n", "nameserver\n", "# nameserver 1.1.1.1\n"])(
    "「%s」では引けない",
    (text) => {
      expect(hasNameserver(text)).toBe(false);
    },
  );

  it("知らせの文言は entrypoint.sh と同じ", () => {
    expect(RESOLVER_WARNING).toBe(
      "WARN: no nameserver in /etc/resolv.conf; /wacz/ will not resolve",
    );
  });
});
