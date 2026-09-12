# replay

Self-hosted [ReplayWeb.page](https://replayweb.page/). Serves the viewer from
this container and proxies WACZ out of an S3-compatible store, so replaying an
archive touches nothing outside the host.

Built for the BrowserHive dev stack, but not tied to it: point `S3_HOST` and
`S3_BUCKET` anywhere that allows anonymous reads on the bucket.

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

## Endpoints

| Path | What it is |
|---|---|
| `/` | ReplayWeb.page. Drop a `.wacz` on it, or pass `?source=`. |
| `/wacz/<key>` | Proxied to `${S3_HOST}/${S3_BUCKET}/<key>`, anonymously. Range requests pass through. |
| `/__version` | `{"version","revision","replaywebpage"}` — what this image was baked from. |
| `/SOURCE.txt` | What is bundled and where its source lives. |

## Configuration

| Variable | Default |
|---|---|
| `S3_BUCKET_URL` | `http://seaweedfs.browserhive:8333/browserhive` |
| `TLS_CERT` | unset — plaintext on 8080 only |
| `TLS_KEY` | unset |

Set `TLS_CERT` and `TLS_KEY` together and the viewer also listens on **443**
with TLS. Both or neither: one alone is refused at startup, because the failure
it produces otherwise is silent — plaintext while you believe it is encrypted.

TLS is not decoration here. **The viewer is a service worker**, and a service
worker only registers in a secure context. Reached over plain http at a
hostname, this image serves the page and then never opens an archive; the
browser has simply not created `navigator.serviceWorker` at all. `localhost` is
the other trustworthy origin, which is why the plaintext example below uses it.

One URL rather than a host and a bucket in two variables, because splitting
them is unsafe under at least one orchestrator: **container-compose rewrites an
environment value that equals the compose project name into a container IP**.
The BrowserHive stack is named `browserhive` and its bucket is named
`browserhive` too, so `S3_BUCKET=browserhive` arrived as `192.168.64.197` and
every read came back 403 — with no error anywhere, since nginx was faithfully
proxying to a bucket named after an IP address. A compound value is left alone.
The entrypoint rejects anything that is not `http(s)://<host>[:<port>]/<bucket>`.

The store must allow **anonymous read** on that bucket — this image sends no
credentials. In the BrowserHive stack that is a SeaweedFS identity named
`anonymous` with `actions: ["Read:<bucket>"]`, which grants GET and HEAD while
leaving list, write and delete refused.

## Bundled software

ReplayWeb.page is **AGPL-3.0-or-later**. Serving it over a network is
distribution, so the image carries `LICENSE-replaywebpage` and `/SOURCE.txt`
naming the version and the upstream repository. This repository's own files
are Unlicense; that does not extend to the bundled viewer.

## Two things that are easy to get wrong

**Publish the port on `127.0.0.1`.** Service workers only register in a secure
context, which means HTTPS or a loopback address. Reaching this container by
its IP or its DNS name from a browser serves the page and then does nothing —
the viewer loads, the archive never opens, and nothing reports an error.

**The store must answer range requests.** wabac reads a WACZ in ~60 partial
reads rather than downloading it. A static server without `206` support
either downloads the whole archive per read or fails outright.

## Updating ReplayWeb.page

```
pnpm add replaywebpage@<version>   # rewrites package.json and the lockfile
docker build -t replay .           # --frozen-lockfile would fail if they disagreed
```

Then tag a release here **before** bumping the submodule pointer in
browserhive — a submodule pointing at an untagged commit fails in CI jobs that
look unrelated to this repository.
