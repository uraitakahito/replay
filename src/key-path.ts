/**
 * 保管庫の鍵を URL の path から読み、上流へ渡す path に組み直す (`/wacz/<鍵>` と `/q/<置き場>`)。
 *
 * 決まり (docs/replay-bundle.md の「/wacz/ の鍵の綴り」):
 *
 *   1. path を `/` で区切り、区切りごとに 1 度だけ百分率の符号を解く。
 *   2. 解いた区切り (`%2F` から出た `/` の両側も) が `.` か `..` なら断る。
 *   3. 上流へは、区切りごとに符号にし直して渡す。
 *
 * nginx の時代は、正規化した URI (符号を解いた物) をそのまま上流へ渡していた。保管庫は path を
 * もう 1 度解くので、鍵に `%XX` そのものを含むと 2 度解かれて別の鍵になった。BrowserHive は
 * ラベルを百分率の符号で鍵に入れる (`hello world` → `hello%20world`) ので、まさにそれを踏む。
 */

/** 区切りごとに解いた鍵。空の区切り (`a//b`) もそのまま残す。 */
export type KeyPath = { ok: true; segments: string[] } | { ok: false; reason: string };

export const decodeKeyPath = (raw: string): KeyPath => {
  const segments: string[] = [];
  for (const part of raw.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return { ok: false, reason: `malformed percent-encoding in path segment: ${part}` };
    }
    // `%2F` を解くと区切りの中に `/` が出る。保管庫は鍵の `/` を区切りとして扱いうるので、
    // その両側も `.`・`..` でないかを見る (`a%2F..%2Fb` を通さない)。
    if (decoded.split("/").some((piece) => piece === "." || piece === "..")) {
      return { ok: false, reason: `dot segments are not allowed in a key: ${part}` };
    }
    segments.push(decoded);
  }
  return { ok: true, segments };
};

/**
 * 区切り 1 つを符号にする。RFC 3986 の unreserved (英数字と `-._~`) のほかは全部符号にする。
 * encodeURIComponent が残す `!'()*` も符号にする —— 保管庫の側の解き方に頼る所を減らすため。
 */
export const encodeKeySegment = (segment: string): string =>
  encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export const encodeKeyPath = (segments: readonly string[]): string =>
  segments.map(encodeKeySegment).join("/");
