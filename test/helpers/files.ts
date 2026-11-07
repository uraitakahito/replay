/**
 * 試験の置き場の道具: 配る 6 つ (image の public/ の代わり) と、TLS の自己署名の証明書。
 * どちらも一時のフォルダに作り、cleanup で消す。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

export const cleanupTemporaryDirectories = (): void => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
};

const temporaryDirectory = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

export const STATIC_CONTENT = {
  "index.html": "<!doctype html><title>viewer</title><p>Date ▲</p>\n",
  "ui.js": "console.log('ui — ▲');\n",
  // Service Worker は 1 MB を超える (CI が image で大きさを見る)。全体を返すかを見るので大きくする
  "sw.js": `// sw\n${"self.x = 1;\n".repeat(150_000)}`,
  __version: '{"version":"v9.9.9","revision":"abc1234","replaywebpage":"2.5.0"}\n',
  "SOURCE.txt":
    "replaywebpage 2.5.0\nlicense: AGPL-3.0-or-later\nsource: https://github.com/webrecorder/replayweb.page\n",
  "LICENSE-replaywebpage": "GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3\n",
} as const;

/** image の public/ と同じ 6 つを置いたフォルダ */
export const makeStaticDirectory = (): string => {
  const dir = temporaryDirectory("viewer-static-");
  for (const [name, content] of Object.entries(STATIC_CONTENT)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
};

export interface SelfSignedCertificate {
  readonly cert: Buffer;
  readonly key: Buffer;
  readonly certPath: string;
  readonly keyPath: string;
}

/**
 * localhost と 127.0.0.1 の自己署名の証明書を openssl で作る。ファイルの名前に .pem・.key を
 * 付けない (手元の許可の設定が、その名前を読むのを止めるため)。
 */
export const makeSelfSignedCertificate = (): SelfSignedCertificate => {
  const dir = temporaryDirectory("viewer-tls-");
  const certPath = join(dir, "tls-certificate");
  const keyPath = join(dir, "tls-private");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return { cert: readFileSync(certPath), key: readFileSync(keyPath), certPath, keyPath };
};

/** 中身を書いた一時のファイル */
export const writeTemporaryFile = (name: string, content: string): string => {
  const path = join(temporaryDirectory("viewer-file-"), name);
  writeFileSync(path, content);
  return path;
};
