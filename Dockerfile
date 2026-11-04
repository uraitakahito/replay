# replay — self-hosted ReplayWeb.page.
# Multi-stage: resolve the viewer from the lockfile, compile the server, run it
# on Node. The last stage is the one that runs: BrowserHive's build-images.mjs
# and capture-ledger's compose both build the last stage without a target.

# node 24, not 26: replaywebpage declares `engines: {node: ">=22 <25"}`.
# Newer bases install fine but every build prints an engine mismatch, and a
# warning nobody can act on is a warning everybody learns to ignore.
FROM node:24-bookworm-slim AS fetch
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --frozen-lockfile is the version pin. The lockfile carries the tarball's
# sha512, so a ReplayWeb.page that quietly moved fails HERE rather than
# changing how an archive replays.
RUN pnpm install --frozen-lockfile --prod

# Only three files are needed to serve the app — measured by logging every
# path the browser asked for. The tarball is 7.3 MB; dist/ (4.7 MB) is the
# Electron build and never leaves the fetch stage.
#
# ruffle/ is deliberately absent. npm ships only its download script, and
# the Flash emulator is the one thing the hosted replayweb.page fetches from
# the network during replay — not shipping it is what makes this image quiet.
RUN mkdir -p /out \
 && cp node_modules/replaywebpage/index.html /out/ \
 && cp node_modules/replaywebpage/ui.js      /out/ \
 && cp node_modules/replaywebpage/sw.js      /out/ \
 && cp node_modules/replaywebpage/LICENSE    /out/LICENSE-replaywebpage

# The fingerprint /__version reports. The build context has no .git
# (.dockerignore), so these are passed in rather than read from git. Left
# unset the image reports version=unknown revision=dev — itself a useful
# signal: it was baked without recording what it was baked from.
ARG GIT_TAG=
ARG GIT_REV=dev
RUN RWP=$(node -p "require('/app/node_modules/replaywebpage/package.json').version") \
 && printf '{"version":"%s","revision":"%s","replaywebpage":"%s"}\n' \
      "${GIT_TAG:-unknown}" "${GIT_REV}" "${RWP}" > /out/__version \
 && printf 'replaywebpage %s\nlicense: AGPL-3.0-or-later\nsource: https://github.com/webrecorder/replayweb.page\n' \
      "${RWP}" > /out/SOURCE.txt

# The server (src/): TypeScript compiled by tsc. It imports nothing but node:
# built-ins, so the run stage takes dist/ and no node_modules at all — the dev
# dependencies installed here (tsc and friends) never leave this stage.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

FROM node:24-bookworm-slim
WORKDIR /app
# package.json for `"type": "module"` (dist/ is ES modules), nothing else.
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY --from=fetch /out ./public
EXPOSE 8080
# No USER: the server starts as root so it can bind 443 when TLS_CERT and
# TLS_KEY are given, reads the certificate and key, opens its ports, and then
# switches itself to the `node` user (src/run.ts) — the same split as nginx's
# root master and unprivileged workers. Granting CAP_NET_BIND_SERVICE to the
# node binary instead was rejected: a file capability that the runtime cannot
# grant (no-new-privileges, cap-drop) makes exec itself fail, which would take
# down the plaintext-only setups too.
#
# Exec form, so node is PID 1 and receives SIGTERM itself; src/run.ts finishes
# the requests in flight and exits 0.
ENTRYPOINT ["node", "--enable-source-maps", "dist/main.js"]
