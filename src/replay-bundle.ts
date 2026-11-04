/**
 * 合本の pages.json (形 v1) を読み、頁の問いに答える。I/O を持たない部分。
 * 形と問いの約束は docs/replay-bundle.md。
 *
 * ReplayWeb.page (wabac.js 2.27 の src/wacz/multiwacz.ts) がこの答えをどう読むか:
 *
 * - 頁を開くとき `?url=<頁の URL>&pageSize=25` で問い、items を先頭から読んで、`url` が問いの URL で
 *   始まらない行で読むのを止める。当たった行の `filename` の WACZ だけを試す。
 * - 当たりが無く URL に query があれば、query を外した URL を `?search=` に入れて問い直し、
 *   同じく先頭から `url` がそれで始まる行だけを使う。
 * - 一覧の 2 ページ目以降と検索は `?search=<語>&page=<n>&pageSize=<m>` (1 ページ目は replay.json の
 *   initialPages から作る)。
 *
 * だから並びは「問いの URL で始まる行を先に」が要る。外れた行が先に来ると、後ろの当たりは読まれない。
 */
import { canonicalUrl } from "./canonical-url.js";

/** pages.json の 1 行 (= WACZ の pages/pages.jsonl の 1 行) */
export interface BundlePage {
  readonly id: string;
  readonly url: string;
  readonly ts: string | null;
  readonly title: string | null;
  /** replay.json の resources[].name と同じ。replay はこの名の WACZ を試す */
  readonly filename: string;
  readonly depth: number | null;
  /** 写しの行 (urn:browserhive:snapshot:…) の段。文書の行は null */
  readonly stage: string | null;
  /** 正規化した URL (頼んだ URL と、リダイレクトの後の文書の URL)。写しの行は空 */
  readonly keys: readonly string[];
}

/** 答えの 1 行。replay が読む欄だけ */
export interface PageItem {
  readonly id: string;
  readonly url: string;
  readonly ts: string | null;
  readonly title: string | null;
  readonly filename: string;
}

export interface PageAnswer {
  readonly items: readonly PageItem[];
  /** 当たりの総数 (ページに切る前) */
  readonly total: number;
}

interface IndexedPage extends BundlePage {
  readonly urlLower: string;
  readonly titleLower: string;
}

/** 読んだ pages.json。行は既定の並び (深さ → 時刻 → id) に並べてある */
export interface PagesIndex {
  readonly pages: readonly IndexedPage[];
}

/** pages.json が形 v1 でない */
export class BundleFormatError extends Error {
  override name = "BundleFormatError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((element: unknown) => typeof element === "string");

const optionalString = (row: Record<string, unknown>, field: string, at: string): string | null => {
  const value = row[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new BundleFormatError(`${at}.${field} is not a string`);
  return value;
};

const requiredString = (row: Record<string, unknown>, field: string, at: string): string => {
  const value = row[field];
  if (typeof value !== "string") throw new BundleFormatError(`${at}.${field} is not a string`);
  return value;
};

const readRow = (raw: unknown, index: number): BundlePage => {
  const at = `pages[${String(index)}]`;
  if (!isRecord(raw)) throw new BundleFormatError(`${at} is not an object`);
  const depth = raw["depth"];
  if (depth !== undefined && depth !== null && typeof depth !== "number") {
    throw new BundleFormatError(`${at}.depth is not a number`);
  }
  const keys = raw["keys"];
  if (!isStringArray(keys)) throw new BundleFormatError(`${at}.keys is not an array of strings`);
  return {
    id: requiredString(raw, "id", at),
    url: requiredString(raw, "url", at),
    ts: optionalString(raw, "ts", at),
    title: optionalString(raw, "title", at),
    filename: requiredString(raw, "filename", at),
    depth: depth ?? null,
    stage: optionalString(raw, "stage", at),
    keys,
  };
};

const compare = <T extends number | string>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);

/** 並べるための数。無い値・読めない時刻は後ろへ */
const depthOf = (page: BundlePage): number => page.depth ?? Number.POSITIVE_INFINITY;
const timeOf = (page: BundlePage): number => {
  const time = page.ts === null ? Number.NaN : Date.parse(page.ts);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
};

/** 既定の並び: 深さ → 時刻 → id */
const byDefaultOrder = (a: BundlePage, b: BundlePage): number =>
  compare(depthOf(a), depthOf(b)) || compare(timeOf(a), timeOf(b)) || compare(a.id, b.id);

/** pages.json の本文を読む。形 v1 でなければ BundleFormatError。 */
export const parsePagesJson = (text: string): PagesIndex => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BundleFormatError(`not JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new BundleFormatError("not an object");
  if (parsed["version"] !== 1) {
    throw new BundleFormatError(`version is ${JSON.stringify(parsed["version"])}, not 1`);
  }
  const pages = parsed["pages"];
  if (!Array.isArray(pages)) throw new BundleFormatError("pages is not an array");
  const rows = pages.map(readRow).sort(byDefaultOrder);
  return {
    pages: rows.map((row) => ({
      ...row,
      urlLower: row.url.toLowerCase(),
      titleLower: (row.title ?? "").toLowerCase(),
    })),
  };
};

export interface PageQuery {
  /** ?url= (正規化の前) */
  readonly url?: string | undefined;
  /** ?search= */
  readonly search?: string | undefined;
  /** 1 から */
  readonly page: number;
  readonly pageSize: number;
}

const item = (page: BundlePage, url: string = page.url): PageItem => ({
  id: page.id,
  url,
  ts: page.ts,
  title: page.title,
  filename: page.filename,
});

/**
 * ?url=: 問いを正規化し (http(s) でなければ 0 件)、keys に同じ物を持つ行を先に、keys のどれかが
 * それで始まる行を後に返す。答えの `url` は、当たった key —— replay は `url` が問いで始まるかで
 * 読み続けるかを決めるので、リダイレクトの後の URL で当たった行に、頼んだ URL を返すと読まれない。
 */
const byUrl = (index: PagesIndex, raw: string): PageItem[] => {
  const wanted = canonicalUrl(raw);
  if (wanted === null) return [];
  const exact: PageItem[] = [];
  const prefixed: PageItem[] = [];
  for (const page of index.pages) {
    if (page.keys.includes(wanted)) {
      exact.push(item(page, wanted));
      continue;
    }
    const longer = page.keys.find((key) => key.startsWith(wanted));
    if (longer !== undefined) prefixed.push(item(page, longer));
  }
  return [...exact, ...prefixed];
};

/**
 * ?search=: url か title が語を含む行 (大小を区別しない)。url が語で始まる行を先に —— replay は
 * query を外した URL をここに入れて問い直し、先頭から `url` がそれで始まる行だけを使う。
 */
const bySearch = (index: PagesIndex, search: string): PageItem[] => {
  const lower = search.toLowerCase();
  const leading: PageItem[] = [];
  const containing: PageItem[] = [];
  for (const page of index.pages) {
    if (!page.urlLower.includes(lower) && !page.titleLower.includes(lower)) continue;
    (page.url.startsWith(search) ? leading : containing).push(item(page));
  }
  return [...leading, ...containing];
};

/** 問いに答える。url があれば url で、無ければ search で、どちらも無ければ全部の行。 */
export const queryPages = (index: PagesIndex, query: PageQuery): PageAnswer => {
  const matched =
    query.url !== undefined
      ? byUrl(index, query.url)
      : query.search !== undefined
        ? bySearch(index, query.search)
        : index.pages.map((page) => item(page));
  const start = (query.page - 1) * query.pageSize;
  return { items: matched.slice(start, start + query.pageSize), total: matched.length };
};
