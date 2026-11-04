/**
 * ReplayWeb.page の 3 つのファイルと、image が焼いた 3 つ (/__version・/SOURCE.txt・
 * /LICENSE-replaywebpage) を配る。ほかの path は配らない (呼び手が 404 にする)。
 *
 * - 起動の時に全部を読んで手元に置く (合わせて数 MB)。足りない物があれば起動しない —— image が
 *   壊れているので、頁が出ないまま黙って起きるより早く分かる。
 * - HTML と JS には `charset=utf-8` を付ける。index.html は meta charset を持たず、nginx は
 *   charset を付けなかったので、一覧の「Date ▲」が化けていた。
 * - ETag と Last-Modified を付け、条件つきの要求には 304 で答える。Service Worker は頁を開く
 *   たびに sw.js (1 MB 余り) が変わったかを訊く。
 * - /ruffle/ruffle.js・/webmanifest.json・/favicons/* は app が求めるが、配らない (404)。ruffle を
 *   入れないのがこの image の目的の 1 つ (README)。
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { StartupError } from "./config.js";
import type { ReplayRequest, ReplayResponse } from "./respond.js";
import { send } from "./respond.js";

const HTML = "text/html; charset=utf-8";
const JAVASCRIPT = "text/javascript; charset=utf-8";

/** path → 置き場のファイルと型。ここに無い path は配らない。 */
const ROUTES: Readonly<Record<string, { file: string; contentType: string }>> = {
  "/": { file: "index.html", contentType: HTML },
  "/index.html": { file: "index.html", contentType: HTML },
  "/ui.js": { file: "ui.js", contentType: JAVASCRIPT },
  "/sw.js": { file: "sw.js", contentType: JAVASCRIPT },
  // 型は nginx の時と同じ (default_type)。中身は ASCII
  "/__version": { file: "__version", contentType: "application/json" },
  "/SOURCE.txt": { file: "SOURCE.txt", contentType: "text/plain" },
  // nginx は拡張子の無いこれを application/octet-stream で返し、ブラウザは落とすだけだった。
  // 読める形で返す (AGPL の写しを受け手が読めるように)
  "/LICENSE-replaywebpage": {
    file: "LICENSE-replaywebpage",
    contentType: "text/plain; charset=utf-8",
  },
};

export interface StaticFile {
  readonly body: Buffer;
  readonly contentType: string;
  readonly etag: string;
  /** HTTP の日付 (秒まで) */
  readonly lastModified: string;
  /** If-Modified-Since と比べる、秒に切り捨てた時刻 (ミリ秒) */
  readonly modifiedMs: number;
}

export type StaticFiles = ReadonlyMap<string, StaticFile>;

/** 置き場 (image の /app/public) から 6 つを読む。読めない物があれば StartupError。 */
export const loadStaticFiles = (dir: string): StaticFiles => {
  const byFile = new Map<string, Omit<StaticFile, "contentType">>();
  const files = new Map<string, StaticFile>();
  for (const [path, { file, contentType }] of Object.entries(ROUTES)) {
    let loaded = byFile.get(file);
    if (loaded === undefined) {
      const location = join(dir, file);
      let body: Buffer;
      let mtimeMs: number;
      try {
        body = readFileSync(location);
        mtimeMs = statSync(location).mtimeMs;
      } catch {
        throw new StartupError(`FATAL: cannot read ${location}`);
      }
      const modifiedMs = Math.floor(mtimeMs / 1000) * 1000;
      loaded = {
        body,
        etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`,
        lastModified: new Date(modifiedMs).toUTCString(),
        modifiedMs,
      };
      byFile.set(file, loaded);
    }
    files.set(path, { ...loaded, contentType });
  }
  return files;
};

/**
 * 条件つきの要求に合うか (RFC 9110 13.2.2 の順)。If-None-Match があれば If-Modified-Since は見ない。
 * If-None-Match は弱い比較 (W/ を外して比べる)。
 */
const notModified = (req: ReplayRequest, file: StaticFile): boolean => {
  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch !== undefined) {
    return ifNoneMatch
      .split(",")
      .map((tag) => tag.trim().replace(/^W\//, ""))
      .some((tag) => tag === "*" || tag === file.etag);
  }
  const ifModifiedSince = req.headers["if-modified-since"];
  if (ifModifiedSince !== undefined) {
    const since = Date.parse(ifModifiedSince);
    return !Number.isNaN(since) && file.modifiedMs <= since;
  }
  return false;
};

/** 1 つ配る。GET と HEAD だけ (呼び手が method を見てから呼ぶ)。 */
export const serveStatic = (req: ReplayRequest, res: ReplayResponse, file: StaticFile): void => {
  const validators = { etag: file.etag, "last-modified": file.lastModified };
  if (notModified(req, file)) {
    res.writeHead(304, validators);
    res.end();
    return;
  }
  send(req, res, 200, file.contentType, file.body, validators);
};
