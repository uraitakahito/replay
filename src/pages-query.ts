/**
 * `GET /q/<置き場>/pages` —— 合本の頁の問い (replay.json の pagesQueryUrl) に答える。
 *
 * 置き場は `org/<orgId>/crawls/<crawlId>/r<版>`。保管庫の `<置き場>/pages.json` を読み、手元に置く。
 * 版の置き場は一度書いたら書き換えない約束なので、新しさを確かめに行かない。置く数には上限を
 * 決め (LRU)、溢れたら長く使っていない物から捨てる。
 *
 * 答えの形・並び・誤りの status は docs/replay-bundle.md の「/q/ の約束」。
 */
import type { IncomingMessage } from "node:http";
import type { Upstream } from "./config.js";
import { decodeKeyPath, encodeKeyPath } from "./key-path.js";
import type { PagesIndex } from "./replay-bundle.js";
import { BundleFormatError, parsePagesJson, queryPages } from "./replay-bundle.js";
import type { ViewerRequest, ViewerResponse } from "./respond.js";
import { refuseUnlessRead, sendJson } from "./respond.js";
import type { UpstreamOptions } from "./upstream.js";
import { UpstreamError, sendUpstream } from "./upstream.js";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** pages.json の大きさの上限。1 万頁でも数 MB なので、桁を 1 つ以上外れた物は読まない */
const MAX_PAGES_JSON_BYTES = 64 * 1024 * 1024;

/** pages.json を読めなかった。status は問いへの答え */
class BundleLoadError extends Error {
  override name = "BundleLoadError";
  readonly status: 404 | 502 | 504;

  constructor(status: 404 | 502 | 504, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

/**
 * 数で上限を決めた LRU。置くのは読み終える前の約束 —— 同じ置き場への問いが同時に来ても、
 * 保管庫へは 1 本しか読みに行かない。読めなかった物は置かない (まだ書かれていないだけかもしれない)。
 */
export class BundleCache {
  readonly #entries = new Map<string, Promise<PagesIndex>>();
  readonly #maxEntries: number;
  readonly #load: (dir: string) => Promise<PagesIndex>;

  constructor(maxEntries: number, load: (dir: string) => Promise<PagesIndex>) {
    this.#maxEntries = maxEntries;
    this.#load = load;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** dir は符号にした置き場 (encodeKeyPath の形)。同じ置き場の綴りの違いを 1 つにまとめる */
  get(dir: string): Promise<PagesIndex> {
    const cached = this.#entries.get(dir);
    if (cached !== undefined) {
      // 使った物を最後へ (Map は入れた順を保つ)
      this.#entries.delete(dir);
      this.#entries.set(dir, cached);
      return cached;
    }
    const loading = this.#load(dir);
    this.#entries.set(dir, loading);
    loading.catch(() => {
      if (this.#entries.get(dir) === loading) this.#entries.delete(dir);
    });
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) break;
      this.#entries.delete(oldest);
    }
    return loading;
  }
}

const readBody = async (answer: IncomingMessage, limit: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of answer) {
    const bytes = chunk as Buffer;
    length += bytes.length;
    if (length > limit) {
      answer.destroy();
      throw new BundleLoadError(502, `pages.json is larger than ${String(limit)} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
};

const fromUpstreamError = (error: unknown): unknown =>
  error instanceof UpstreamError
    ? new BundleLoadError(error.kind === "timeout" ? 504 : 502, error.message, { cause: error })
    : error;

/** 保管庫の `<dir>/pages.json` を読む。dir は符号にした置き場。 */
export const loadPagesJson = async (
  upstream: Upstream,
  options: UpstreamOptions,
  dir: string,
): Promise<PagesIndex> => {
  const { response } = sendUpstream(
    upstream,
    { method: "GET", path: `${upstream.basePath}/${dir}/pages.json`, headers: {} },
    options,
  );
  let body: Buffer;
  try {
    const answer = await response;
    if (answer.statusCode !== 200) {
      answer.resume();
      if (answer.statusCode === 404) throw new BundleLoadError(404, `no pages.json in ${dir}`);
      throw new BundleLoadError(
        502,
        `the store answered ${String(answer.statusCode)} for ${dir}/pages.json`,
      );
    }
    body = await readBody(answer, MAX_PAGES_JSON_BYTES);
  } catch (error) {
    throw fromUpstreamError(error);
  }
  try {
    return parsePagesJson(body.toString("utf8"));
  } catch (error) {
    if (!(error instanceof BundleFormatError)) throw error;
    throw new BundleLoadError(
      502,
      `${dir}/pages.json is not a replay bundle v1: ${error.message}`,
      {
        cause: error,
      },
    );
  }
};

const REVISION = /^r[1-9][0-9]*$/;

/**
 * `/q/` の後ろ (符号のまま) から置き場を読む。`<置き場>/pages` の形でなければ 404、置き場の形が
 * 違う・`.`・`..` を含むなら 400。
 */
const parseQueryPath = (
  rawRest: string,
): { ok: true; dir: string } | { ok: false; status: 400 | 404; reason: string } => {
  const suffix = "/pages";
  if (!rawRest.endsWith(suffix)) return { ok: false, status: 404, reason: "not found" };
  const decoded = decodeKeyPath(rawRest.slice(0, -suffix.length));
  if (!decoded.ok) return { ok: false, status: 400, reason: decoded.reason };
  const [org, orgId, crawls, crawlId, revision] = decoded.segments;
  const named = (segment: string | undefined) =>
    segment !== undefined && segment !== "" && !segment.includes("/");
  if (
    decoded.segments.length !== 5 ||
    org !== "org" ||
    !named(orgId) ||
    crawls !== "crawls" ||
    !named(crawlId) ||
    revision === undefined ||
    !REVISION.test(revision)
  ) {
    return {
      ok: false,
      status: 400,
      reason: "the bundle directory must be org/<orgId>/crawls/<crawlId>/r<revision>",
    };
  }
  return { ok: true, dir: encodeKeyPath(decoded.segments) };
};

/** 1 以上の整数 (先頭に 0 を置かない・9 桁まで)。無ければ fallback、形が違えば undefined */
const positiveInteger = (value: string | null, fallback: number): number | undefined => {
  if (value === null) return fallback;
  return /^[1-9][0-9]{0,8}$/.test(value) ? Number(value) : undefined;
};

export interface PagesQueryContext {
  readonly cache: BundleCache;
  readonly logError: (line: string) => void;
}

/**
 * @param rawRest  `/q/` の後ろの path (符号のまま)
 * @param rawQuery `?` の後ろ (無ければ undefined)
 */
export const answerPagesQuery = async (
  req: ViewerRequest,
  res: ViewerResponse,
  rawRest: string,
  rawQuery: string | undefined,
  context: PagesQueryContext,
): Promise<void> => {
  const where = parseQueryPath(rawRest);
  if (!where.ok) {
    sendJson(req, res, where.status, { error: where.reason });
    return;
  }
  if (refuseUnlessRead(req, res)) return;
  const params = new URLSearchParams(rawQuery ?? "");
  const page = positiveInteger(params.get("page"), 1);
  const pageSize = positiveInteger(params.get("pageSize"), DEFAULT_PAGE_SIZE);
  if (page === undefined || pageSize === undefined) {
    sendJson(req, res, 400, { error: "page and pageSize must be positive integers" });
    return;
  }
  let index: PagesIndex;
  try {
    index = await context.cache.get(where.dir);
  } catch (error) {
    if (!(error instanceof BundleLoadError)) throw error;
    if (error.status !== 404) context.logError(`/q/${rawRest}: ${error.message}`);
    sendJson(req, res, error.status, { error: error.message });
    return;
  }
  const answer = queryPages(index, {
    url: params.get("url") ?? undefined,
    search: params.get("search") ?? undefined,
    page,
    pageSize: Math.min(pageSize, MAX_PAGE_SIZE),
  });
  sendJson(req, res, 200, answer);
};
