# 合本（replay bundle）の形 v1

クロール 1 本を、[ReplayWeb.page](https://replayweb.page/)（ブラウザで動く WACZ のビューア）で 1 つの
アーカイブとして開くための置き方と、replayweb-server（この repo）がそれに答える約束。合本は `replay.json` と `pages.json`
の組で、WACZ（Web Archive Collection Zipped。撮った頁の通信を詰めた zip）と同じ保管庫に置く。

- 書くのは [capture-ledger](https://github.com/uraitakahito/capture-ledger)（クロールの台帳。クロールの段ごとに
  新しい版を書く）。
- 読むのは replayweb-server と、ReplayWeb.page。
- 正規化の試験の例は [`test/vectors/canonical-url.json`](../test/vectors/canonical-url.json)。capture-ledger は写しを持ち、
  同じ例で同じ式を縛る。

## 開き方

```
https://<replayweb-server>/?source=/wacz/<置き場>/replay.json
```

`?source=` の URL は `.json` で終わる必要がある（ReplayWeb.page は拡張子だけで JSON かを決める）。
`replay.json` は `/wacz/` を通して保管庫から読まれ、`pagesQueryUrl` の問いは replayweb-server の `/q/` が答える。
開くときに通るのは replayweb-server と保管庫だけで、台帳（capture-ledger の API）は要らない。

## 置き場

- 合本の置き場（以下 `<置き場>`）は `org/<orgId>/crawls/<crawlId>/r<版>`。WACZ と同じ bucket に置く。
- 中身は `<置き場>/replay.json` と `<置き場>/pages.json`（どちらも `application/json`）。
- **一度書いた版は書き換えない。** 合本を作り直すときは、新しい版の置き場に書く。replayweb-server は、
  読んだ `pages.json` を新しさを確かめずに手元に置く。
- 版は 1 から始まる整数（クロールごと）。台帳が払い出し、台帳が指す版は前へだけ進む。
- 終わったクロール（succeeded・failed）の版には、台帳が署名した `<置き場>/replay-digest.json`
  （`{path: "replay.json", hash, signedData}`。WACZ の `datapackage-digest.json` と同じ形）が在りうる。
  replayweb-server は読まない。何を証すかと検め方は、
  [capture-ledger](https://github.com/uraitakahito/capture-ledger) の docs（archive-ledger の「合本の署名」）に在る。

## replay.json

ReplayWeb.page の `?source=` に渡す物。

```json
{
  "title": "クロール 3f2a1b2c の合本 r3",
  "resources": [
    {
      "name": "a4d7…_3f2a….wacz",
      "path": "/wacz/org/acme/2026-11/a4d7…_3f2a….wacz",
      "hash": "sha256:<WACZ の sha256>",
      "crawlId": "<crawlId>"
    }
  ],
  "pagesQueryUrl": "/q/org/acme/crawls/<crawlId>/r3/pages",
  "initialPages": [
    {
      "id": "…",
      "url": "http://site.test/",
      "ts": "2026-11-05T01:03:57.957Z",
      "title": "hub",
      "filename": "a4d7…_3f2a….wacz",
      "isSeed": true,
      "crawl_id": "<crawlId>"
    }
  ],
  "totalPages": 412,
  "replayBundle": {
    "version": 1,
    "crawlId": "<crawlId>",
    "rev": 3,
    "depth": 2,
    "builtAt": "2026-11-05T03:30:00.000Z",
    "members": 140,
    "skipped": 2,
    "crawlState": "succeeded",
    "stopReason": "completed",
    "finishedAt": "2026-11-05T03:29:58.000Z",
    "skippedResources": [{ "name": "b7e1…_3f2a….wacz", "hash": "sha256:…" }],
    "pagesHash": "sha256:<pages.json の sha256>"
  }
}
```

| 欄                 | 中身                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resources[].name` | WACZ の鍵の最後の区切り（ファイル名）。クロールの中で一意。`/` を含めない。`pages.json` と `initialPages` の `filename` はこの名を指す                                                                          |
| `resources[].path` | `/wacz/` ＋ WACZ の鍵。鍵は区切りごとに百分率の符号にする（下の「`/wacz/` の鍵の綴り」）。origin の根からの path                                                                                                |
| `resources[].hash` | `sha256:` ＋ WACZ のファイル全体の sha256（16 進の小文字）。ReplayWeb.page は照らさない（呼び分けの名前に使う）。証拠のために載せる                                                                             |
| `resources` の並び | **起点の頁の WACZ を先頭に**、続けて深さ・撮った時刻の順。ただし ReplayWeb.page が頁の中で見つからない物（favicon など）を探す 3 本は、この並びではなく WACZ の名前（`name`）の順で選ばれる（2.5.0 で確かめた） |
| `pagesQueryUrl`    | `/q/` ＋ `<置き場>` ＋ `/pages`（末尾の `/` は無し）                                                                                                                                                            |
| `initialPages`     | 一覧の 1 ページ目。25 行まで。起点の頁（深さ 0）を先頭に、深さ・時刻の順。`isSeed` は深さ 0 の頁で true。写しの行は入れない                                                                                     |
| `totalPages`       | `pages.json` の `pages` の数                                                                                                                                                                                    |
| `replayBundle`     | 台帳の記録。ReplayWeb.page も replayweb-server も読まない（知らない欄は読み飛ばす）。ほかの欄の名前とぶつけない。欄の意味は台帳の docs                                                                          |

## pages.json

replayweb-server だけが読む。

```json
{
  "version": 1,
  "crawlId": "<crawlId>",
  "rev": 3,
  "pages": [
    {
      "id": "a4d7…",
      "url": "http://site.test/",
      "ts": "2026-11-05T01:03:57.957Z",
      "title": "hub",
      "filename": "a4d7…_3f2a….wacz",
      "depth": 0,
      "stage": null,
      "keys": ["http://site.test/", "http://site.test/after-redirect"]
    },
    {
      "id": "a4d7…-after-load",
      "url": "urn:browserhive:snapshot:after-load:http://site.test/",
      "ts": "2026-11-05T01:04:00.324Z",
      "title": "hub",
      "filename": "a4d7…_3f2a….wacz",
      "depth": 0,
      "stage": "after-load",
      "keys": []
    }
  ]
}
```

- `version` は `1`。ほかの版は読まない（`/q/` が 502 で答える）。
- 1 行 = WACZ の `pages/pages.jsonl` の 1 行（先頭の `{"format":…}` の行は除く）。`url`・`ts`・`title`・
  `stage` はそのまま写す（無ければ `null`）。`filename` は `resources[].name`。`depth` は台帳の深さ。
- `id` もそのまま写す。ただし行に無ければ、書き手（台帳）が `<filename>#<pages.jsonl の中で何番目の頁の行か（0 から）>`
  を振る。`id` は必ず文字列で、合本の中で一意（`initialPages` の `id` も同じ）。
- 要る欄は `id`・`url`・`filename`（文字列）と `keys`（文字列の配列）。`ts`・`title`・`stage` は文字列か `null`、
  `depth` は数か `null`。形が違えば `/q/` は 502 で答える。
- `keys` は文書の行（`stage` が無い行）だけに入れる。頼んだ URL と、
  [BrowserHive](https://github.com/uraitakahito/browserhive)（頁を撮って WACZ にする server）の答えの `document.url`
  （リダイレクトの後。在れば）を、下の正規化に通した物。重複は 1 つに。写しの行は空。
- 行の並びに約束は無い（server が自分で並べる）。

## 正規化

```ts
const canonicalUrl = (raw: string): string | null => {
  const url = URL.parse(raw);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  url.hash = "";
  return url.toString();
};
```

WHATWG の URL として読み、scheme が http か https でなければ `null`。fragment を外して直列化する。
capture-ledger の `parseHttpUrl` と同じ式で、ReplayWeb.page が頁の問いに入れる URL（`new URL(u)` の
fragment を外した `href`）とも同じになる。例は [`test/vectors/canonical-url.json`](../test/vectors/canonical-url.json)。

## 外す WACZ

`indexes/index.cdxj` の大きさが 0、または BrowserHive の答えの `waczStats.totalRecorded` が 0 の WACZ は、
`resources` にも `pages.json` にも入れない。ReplayWeb.page は長さ 0 の Range を求め、保管庫の 416 を受けて
JSON を読み直し続けるため。外した数は `replayBundle.skipped`。

## `/q/` の約束

```
GET /q/<置き場>/pages?url=<u>&pageSize=25
GET /q/<置き場>/pages?search=<s>&page=<n>&pageSize=<m>
```

server は保管庫の `<置き場>/pages.json`（`S3_BUCKET_URL` ＋ `/` ＋ `<置き場>/pages.json`）を読む。

**問い**

| 問い          | 当たる行と並び                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `?url=<u>`    | `u` を正規化し（`null` なら 0 件）、`keys` に同じ物を持つ行を先に、`keys` のどれかがそれで始まる行を後に |
| `?search=<s>` | `url` か `title` が `s` を含む行（大小を区別しない）。`url` が `s` で始まる行を先に、ほかを後に          |
| どちらも無い  | 全部の行（写しの行も）                                                                                   |

- 両方あれば `url` で引き、`search` は見ない。
- 同じ組の中は、深さ → 時刻 → `id` の順（深さと時刻の無い行は後ろ）。
- `page` は 1 から（既定 1）。`pageSize` は既定 25・上限 100（超えた値は 100 として扱う）。どちらも
  1 以上の整数でなければ 400。

**答え**

```json
{
  "items": [
    {
      "id": "…",
      "url": "http://site.test/",
      "ts": "2026-11-05T01:03:57.957Z",
      "title": "hub",
      "filename": "a4d7…_3f2a….wacz"
    }
  ],
  "total": 2
}
```

- `200`・`application/json; charset=utf-8`・Content-Length。CORS（Cross-Origin Resource Sharing。別の origin
  からの読みを許す）の header は付けない。
- `total` は当たりの総数（ページに切る前）。
- `?url=` の答えの `url` は**当たった key**（同じ行なら正規化した `u`、前方一致の行なら `u` で始まる key）。
  `?search=` と問い無しの答えの `url` は行の `url`。

**誤り**（本文は `{"error": "<理由>"}`）

| status | とき                                                                                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `<置き場>` の形が `org/<orgId>/crawls/<crawlId>/r<版>` でない（版は先頭が 0 でない整数）・`.` か `..` の区切りを含む・百分率の符号が壊れている・`page`・`pageSize` が 1 以上の整数でない |
| 404    | 保管庫に `<置き場>/pages.json` が無い（保管庫の 404）。`/q/` の後ろが `<置き場>/pages` の形でない                                                                                        |
| 405    | GET と HEAD のほか                                                                                                                                                                       |
| 502    | 保管庫に届かない・404 のほかの status で断られた・`pages.json` が形 v1 でない                                                                                                            |
| 504    | 保管庫が答えないまま時間が切れた                                                                                                                                                         |

**手元に置く**

読んだ `pages.json` は、置き場ごとに数で上限を決めて手元に置く（使っていない物から捨てる）。版の置き場は
書き換えない約束なので、新しさは確かめない。同じ置き場への問いが同時に来ても、保管庫へは 1 本しか
読みに行かない。読めなかった結果（404 など）は置かない —— 書かれる前に問われただけかもしれない。

### なぜこの並びか

ReplayWeb.page（wabac.js 2.27）は、頁を開くとき `?url=<頁の URL>&pageSize=25` で問い、`items` を先頭から読んで、
**`url` が問いの URL で始まらない行で読むのを止める**。当たった行の `filename` の WACZ だけを試す。

- 外れた行が先に来ると、後ろの当たりは読まれない。だから `?url=` は同じ行を先に、前方一致の行を後に返す。
- リダイレクトの後の URL（`keys` の 2 つ目）で当たった行に、頼んだ URL を `url` として返すと、その行で止まる。
  だから答えの `url` は当たった key にする。
- 当たりが無く URL に query があると、query を外した URL を `?search=` に入れて問い直し、同じく先頭から `url` が
  それで始まる行だけを使う。だから `?search=` も `url` が語で始まる行を先に返す。
- 一覧の 1 ページ目は `initialPages` から作られ、`/q/` は検索と 2 ページ目以降にだけ使われる。

## `/wacz/` の鍵の綴り

`/wacz/<鍵>` は保管庫の `<S3_BUCKET_URL>/<鍵>` へ中継する。鍵の綴りの決まり:

1. path を `/` で区切り、**区切りごとに 1 度だけ**百分率の符号を解く。
2. 解いた区切り（`%2F` から出た `/` の両側も）が `.` か `..` なら 400。百分率の符号が壊れていても 400。
3. 上流へは、区切りごとに符号にし直して渡す（RFC 3986 の unreserved のほかは全部符号にする）。空の区切り
   （`a//b`）は併せずにそのまま渡す。

書く側（`resources[].path`）は、鍵を `/` で区切り、区切りごとに `encodeURIComponent` してから `/` で繋ぐ。
BrowserHive はラベルを百分率の符号で鍵に入れる（`hello world` → `hello%20world`）ので、鍵そのものが `%` を
含みうる。その `%` も `%25` に符号にすること。

```ts
const waczPath = (key: string) => `/wacz/${key.split("/").map(encodeURIComponent).join("/")}`;
// 鍵 org/acme/2026-11/a_c1_hello%20world.wacz
// → /wacz/org/acme/2026-11/a_c1_hello%2520world.wacz
```

（nginx の時代は、解いた鍵をそのまま上流へ渡し、保管庫がもう 1 度解いていた。`%XX` を含む鍵は 2 度解かれて
別の鍵になった。）

ほかの中継の決まり（query は書いたとおり・範囲と条件の header だけを渡し Authorization は渡さない・答えは
そのまま・届かなければ 502、時間切れは 504）は [README](../README.md#endpoints) にある。
