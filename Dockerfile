# replay — self-hosted ReplayWeb.page.
# Multi-stage: resolve the viewer from the lockfile, ship three static files.

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

FROM nginx:1.29-alpine
# replay.conf is a template, not a config: entrypoint.sh substitutes the
# upstream into conf.d/ at start. Putting it under conf.d/ directly would
# make nginx read the unsubstituted ${S3_HOST} and fail.
COPY nginx/replay.conf /etc/nginx/templates/replay.conf
COPY nginx/entrypoint.sh /entrypoint.sh
COPY --from=fetch /out /usr/share/nginx/html
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
