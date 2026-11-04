/**
 * 合本の URL の正規化 (docs/replay-bundle.md の「正規化」)。
 *
 * WHATWG の URL として読み、scheme が http か https でなければ null。fragment を外して直列化する。
 * capture-ledger の parseHttpUrl (src/crawl/scope.ts) と同じ式で、両方の repo が
 * test/vectors/canonical-url.json の例で縛る。pages.json の keys はこの形で書かれ、/q/ の ?url= も
 * この形にしてから比べる。
 *
 * ReplayWeb.page (wabac.js) が頁の問いに入れる URL も、同じ式で作られる (`new URL(u)` の fragment を
 * 外した href)。だから keys と問いが、片側だけの綴りの違いで外れない。
 */
export const canonicalUrl = (raw: string): string | null => {
  const url = URL.parse(raw);
  if (url === null) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  return url.toString();
};
