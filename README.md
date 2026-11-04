# replay

Self-hosted [ReplayWeb.page](https://replayweb.page/). A small Node server serves
the viewer from this container, proxies WACZ out of an S3-compatible store, and
answers page queries for replay bundles — a whole crawl opened as one archive —
so replaying touches nothing outside the host.

Built for the dev stacks of [BrowserHive](https://github.com/uraitakahito/browserhive)
(the capture server that writes WACZ) and
[capture-ledger](https://github.com/uraitakahito/capture-ledger) (the crawl
ledger that writes replay bundles), but not tied to them: point `S3_BUCKET_URL`
at any bucket that allows anonymous reads.

## Why not just use replayweb.page

Three reasons, in increasing order of importance:

1. **The Flash emulator is fetched live.** Replaying through the hosted app
   pulls `ruffle/ruffle.js` (105 kB) from `replayweb.page` — the only request
   that leaves the machine during an otherwise archive-only replay. This image
   does not ship ruffle, so there is nothing to fetch.
2. **The app itself is a network dependency.** `index.html` + `ui.js` +
   `sw.js` is ~2 MB, served from replayweb.page on a cold load.
3. **The version moves.** replayweb.page ships new releases. Pinning the
   archive but not the player means the same WACZ can render differently
   later. Here the player is pinned by `pnpm-lock.yaml` and baked into the
   image, and `/__version` reports what is running.

## Run

```
docker build -t replay .
docker run --rm -p 8899:8080 replay
open "http://127.0.0.1:8899/"
```

Inside the BrowserHive stack, where the object store is reachable:

```
open "http://127.0.0.1:8899/?source=/wacz/<taskId>_<label>.wacz"
```

A crawl as one archive, from the replay bundle capture-ledger writes next to its
WACZ (the format is [docs/replay-bundle.md](docs/replay-bundle.md)):

```
open "http://127.0.0.1:8899/?source=/wacz/org/<orgId>/crawls/<crawlId>/r<rev>/replay.json"
```

## Endpoints

| Path                     | What it is                                                                     |
| ------------------------ | ------------------------------------------------------------------------------ |
| `/`, `/index.html`       | ReplayWeb.page. Drop a `.wacz` on it, or pass `?source=`.                      |
| `/ui.js`, `/sw.js`       | The rest of ReplayWeb.page.                                                    |
| `/wacz/<key>`            | Proxied to `${S3_BUCKET_URL}/<key>`, anonymously. Range requests pass through. |
| `/q/<bundle dir>/pages`  | Page queries for a replay bundle, answered from its `pages.json` in the store. |
| `/__version`             | `{"version","revision","replaywebpage"}` — what this image was baked from.     |
| `/SOURCE.txt`            | What is bundled and where its source lives.                                    |
| `/LICENSE-replaywebpage` | ReplayWeb.page's licence.                                                      |

Everything else is 404 — including `/ruffle/ruffle.js`, `/webmanifest.json` and
`/favicons/*`, which the app asks for. No response carries CORS headers. HTML
and JavaScript are served with `charset=utf-8` (`index.html` has no meta
charset, and without it the list's "Date ▲" came out garbled). The static files
carry an `ETag` and `Last-Modified` and answer conditional requests with 304 —
the service worker asks whether `sw.js` (1 MB+) changed on every page load.

**`/wacz/<key>`** reads the store and nothing else:

- The key is decoded **once per path segment** and re-encoded segment by
  segment for the store, so a key that itself contains `%XX` (BrowserHive
  percent-encodes labels into keys) reaches the store intact. `.` and `..`
  segments — `%2E%2E` and `%2F..%2F` included — are refused with 400. Build
  the path by encoding each segment of the key; the rule is in
  [docs/replay-bundle.md](docs/replay-bundle.md#wacz-の鍵の綴り).
- The query string is passed through verbatim.
- Only the range and conditional request headers go upstream (`Range`,
  `If-Range`, `If-Match`, `If-None-Match`, `If-Modified-Since`,
  `If-Unmodified-Since`). `Authorization` is never sent: the store is read
  anonymously, and whatever credential the browser sent this host is not the
  store's. `Host` is the store's host and port.
- The store's status, headers and body come back as they are — `206`,
  `Content-Range`, `Accept-Ranges`, `application/wacz+zip` — minus the
  connection-specific headers. Nothing is cached. wabac reads a WACZ in ~60
  range requests rather than downloading it.
- GET and HEAD only (405 otherwise). A store that cannot be reached is 502; one
  that does not answer within 60 seconds is 504.
- The store's name is resolved on every request, IPv4 only. Apple Container's
  DNS answers AAAA first and there is no v6 route between the VMs (BrowserHive
  itself runs with `--dns-result-order=ipv4first` for the same reason), and
  resolving at request time is what lets the viewer start before the store
  does — the stacks start services in whatever order they like.

**`/q/<bundle dir>/pages`** answers ReplayWeb.page's `pagesQueryUrl` queries
(`?url=`, `?search=`, `page`, `pageSize`) from `<bundle dir>/pages.json` in the
store, which is kept in memory once read: a bundle revision is written once and
never changed. The contract — directory shape, ordering, answer, errors — is in
[docs/replay-bundle.md](docs/replay-bundle.md#q-の約束).

## Configuration

| Variable        | Default                                             |
| --------------- | --------------------------------------------------- |
| `S3_BUCKET_URL` | `http://seaweedfs.crawler-storage:8333/browserhive` |
| `TLS_CERT`      | unset — plaintext on 8080 only                      |
| `TLS_KEY`       | unset                                               |

Set `TLS_CERT` and `TLS_KEY` together and the viewer also listens on **443**
with TLS (HTTP/2 and HTTP/1.1); 8080 stays open. Both or neither: one alone is
refused at startup, because the failure it produces otherwise is silent —
plaintext while you believe it is encrypted.

TLS is not decoration here. **The viewer is a service worker**, and a service
worker only registers in a secure context. Reached over plain http at a
hostname, this image serves the page and then never opens an archive; the
browser has simply not created `navigator.serviceWorker` at all. `localhost` is
the other trustworthy origin, which is why the plaintext example above uses it.

One URL rather than a host and a bucket in two variables, because splitting
them is unsafe under at least one orchestrator: **container-compose rewrites an
environment value that equals the name of a service it has already started into
that service's IP** (the service name, not the project name; whether it happens
depends on the start order). The BrowserHive stack has a service named
`browserhive` and its bucket is named `browserhive` too, so
`S3_BUCKET=browserhive` arrived as `192.168.64.197` and
every read came back 403 — with no error anywhere, since the viewer was
faithfully proxying to a bucket named after an IP address. A compound value is
left alone. The server rejects anything that is not
`http(s)://<host>[:<port>]/<bucket>`.

The store must allow **anonymous read** on that bucket — this image sends no
credentials. In the BrowserHive stack that is a SeaweedFS identity named
`anonymous` with `actions: ["Read:<bucket>"]`, which grants GET and HEAD while
leaving list, write and delete refused.

### Startup

These stop the container with exit code 1, one line on stderr each:

```
FATAL: S3_BUCKET_URL must be http(s)://<host>[:<port>]/<bucket>, got: <value>
FATAL: TLS_CERT and TLS_KEY must be set together (only one was given)
FATAL: cannot read <path>
```

`FATAL: cannot use TLS_CERT and TLS_KEY: …` (a certificate and key that do not
load) and `FATAL: cannot listen: …` stop it too. A missing nameserver does not:

```
WARN: no nameserver in /etc/resolv.conf; /wacz/ will not resolve
```

A store that does not resolve at startup does not either — `/` is served and
only `/wacz/` and `/q/` answer 502 until it does.

The server starts as root so it can bind 443, reads the certificate and key,
opens its ports and then switches itself to the `node` user — the same split as
a root nginx master with unprivileged workers. It runs as PID 1 and handles
SIGTERM itself: requests in flight get up to three seconds to finish, then it
exits 0. Every request is logged on stdout, one line each.

## Bundled software

ReplayWeb.page is **AGPL-3.0-or-later**. Serving it over a network is
distribution, so the image carries `LICENSE-replaywebpage` and `/SOURCE.txt`
naming the version and the upstream repository. The app's files are served
exactly as published. This repository's own files are Unlicense; that does not
extend to the bundled viewer.

## Two things that are easy to get wrong

**Publish the port on `127.0.0.1`.** Service workers only register in a secure
context, which means HTTPS or a loopback address. Reaching this container by
its IP or its DNS name from a browser serves the page and then does nothing —
the viewer loads, the archive never opens, and nothing reports an error.

**The store must answer range requests.** wabac reads a WACZ in ~60 partial
reads rather than downloading it. A static server without `206` support
either downloads the whole archive per read or fails outright.

## Development

The server is TypeScript in `src/`, compiled by `tsc` to `dist/` and run on
Node 24 with no runtime dependencies — `node:` built-ins only.

```
pnpm install
pnpm run check   # typecheck, lint, format:check, test, build — what CI's check job runs
```

The tests start the server in-process against a stand-in store (a small
`node:http` server answering like an anonymous S3 bucket) and a stub DNS, and
make a self-signed certificate with `openssl` for the TLS cases. The image is
checked separately in CI (`.github/workflows/ci.yml`): it is built, run, and
probed for what the stacks depend on.

## Updating ReplayWeb.page

```
pnpm add replaywebpage@<version>   # rewrites package.json and the lockfile
docker build -t replay .           # --frozen-lockfile would fail if they disagreed
pnpm audit --audit-level=low       # what .github/workflows/audit.yml runs
```

`pnpm-workspace.yaml` skips advisories (`auditConfig.ignoreGhsas`) that cannot
be fixed from here. The comment beside each says how to tell whether it can be
removed; if so, delete the entry in the same pull request.

Then tag a release here **before** bumping the submodule pointer in
browserhive — a submodule pointing at an untagged commit fails in CI jobs that
look unrelated to this repository.
