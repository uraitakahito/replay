/**
 * 起動の設定を環境変数から読む。nginx の entrypoint.sh が見ていたことを、同じ順と同じ文言で見る。
 *
 * 文言は変えない。消費者の compose のコメントに写されている (BrowserHive と capture-ledger の
 * docker-compose.yml が `S3_BUCKET_URL must be http(s)://…, got: …` を引いている)。
 */

/** 起動を止める誤り。message は stderr に出す 1 行そのもの (`FATAL: …`)。 */
export class StartupError extends Error {
  override name = "StartupError";
}

/**
 * 既定の保管庫。crawler の repo が共有する SeaweedFS (project `crawler-storage`) の bucket。
 * この image を動かす 2 つのスタックはどちらも値を書くので、既定は image を単独で動かすときのため。
 */
export const DEFAULT_S3_BUCKET_URL = "http://seaweedfs.crawler-storage:8333/browserhive";

/** 保管庫の bucket。`/wacz/` と `/q/` は、この path の下の鍵だけを読む。 */
export interface Upstream {
  readonly protocol: "http:" | "https:";
  /** IPv6 の literal は角括弧を外した形 (http.request に渡す形) */
  readonly hostname: string;
  readonly port: number;
  /** bucket の path。末尾の `/` は無い (`/browserhive`) */
  readonly basePath: string;
}

export interface Config {
  /** 環境変数のまま (既定を補った後)。起動の行に出す */
  readonly bucketUrl: string;
  readonly upstream: Upstream;
  /** TLS_CERT と TLS_KEY が揃ったときだけ */
  readonly tls: { readonly cert: Buffer; readonly key: Buffer } | undefined;
}

/**
 * entrypoint.sh の `case` の glob と同じ形: 小文字の `http://` か `https://`、何か、`/`、1 字以上
 * (glob の `*` は `/` を含む何にでも合う)。
 */
const BUCKET_URL_GLOB = /^https?:\/\/[\s\S]*\/[\s\S]+$/;

/**
 * S3_BUCKET_URL を読む。glob に合い、かつ URL として host と bucket を持つときだけ通す。
 *
 * glob だけだと `http:///x` (host が空) や `http://h/b?x` (query) も通り、nginx はそれで起きて
 * 要求の時に壊れていた。断るときの文言は同じ (`http(s)://<host>[:<port>]/<bucket>` の形の外)。
 */
export const parseBucketUrl = (value: string): Upstream => {
  const refused = new StartupError(
    `FATAL: S3_BUCKET_URL must be http(s)://<host>[:<port>]/<bucket>, got: ${value}`,
  );
  if (!BUCKET_URL_GLOB.test(value)) throw refused;
  const url = URL.parse(value);
  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw refused;
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  if (basePath === "") throw refused;
  return {
    protocol: url.protocol,
    hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
    basePath,
  };
};

const readOrRefuse = (path: string, readFile: (path: string) => Buffer): Buffer => {
  try {
    return readFile(path);
  } catch {
    throw new StartupError(`FATAL: cannot read ${path}`);
  }
};

/**
 * 環境変数を読む。順は entrypoint.sh と同じ: S3_BUCKET_URL の形 → TLS の 2 つ。
 *
 * S3_BUCKET_URL が無い・空なら既定値。TLS_CERT と TLS_KEY は両方か、どちらも無しか。片方だけは
 * 設定の誤りで、そのまま起きると「暗号化したつもりで平文」になる —— 黙って起きずに止める。
 */
export const loadConfig = (
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => Buffer,
): Config => {
  const given = env["S3_BUCKET_URL"];
  const bucketUrl = given === undefined || given === "" ? DEFAULT_S3_BUCKET_URL : given;
  const upstream = parseBucketUrl(bucketUrl);

  const certPath = env["TLS_CERT"] ?? "";
  const keyPath = env["TLS_KEY"] ?? "";
  if (certPath !== "" && keyPath !== "") {
    const cert = readOrRefuse(certPath, readFile);
    const key = readOrRefuse(keyPath, readFile);
    return { bucketUrl, upstream, tls: { cert, key } };
  }
  if (certPath !== "" || keyPath !== "") {
    throw new StartupError("FATAL: TLS_CERT and TLS_KEY must be set together (only one was given)");
  }
  return { bucketUrl, upstream, tls: undefined };
};

/**
 * 名前を引く先が無いときの知らせ。起動は止めない —— 頁は配れて、壊れるのは /wacz/ と /q/ だけ
 * (それは引く先が無ければどのみち壊れる)。
 */
export const RESOLVER_WARNING = "WARN: no nameserver in /etc/resolv.conf; /wacz/ will not resolve";

/** resolv.conf の中身 (読めなければ undefined) に、`nameserver <addr>` の行が在るか。 */
export const hasNameserver = (resolvConf: string | undefined): boolean =>
  resolvConf !== undefined && /^nameserver[ \t]+\S/m.test(resolvConf);
