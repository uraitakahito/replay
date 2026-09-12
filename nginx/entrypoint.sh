#!/bin/sh
# Render replay.conf, teach nginx how to resolve names, then hand over.
set -eu

# Where the bucket lives, as one URL rather than host + bucket in two
# variables. That is not cosmetic: container-compose rewrites an environment
# VALUE that equals the compose project name into that project's container IP.
# The BrowserHive stack is named `browserhive` and its bucket is also named
# `browserhive`, so `S3_BUCKET=browserhive` arrived here as `192.168.64.197`
# and every read came back 403 with the IP in the bucket position (measured).
# A compound value like this one is not touched.
: "${S3_BUCKET_URL:=http://seaweedfs.browserhive:8333/browserhive}"
export S3_BUCKET_URL

# Fail loudly on a shape we cannot serve. The failure this guards against is
# silent otherwise: nginx starts happily and every /wacz/ read 403s.
case "${S3_BUCKET_URL}" in
  http://*/?*|https://*/?*) ;;
  *)
    echo "FATAL: S3_BUCKET_URL must be http(s)://<host>[:<port>]/<bucket>, got: ${S3_BUCKET_URL}" >&2
    exit 1
    ;;
esac

# TLS, if a certificate and key were handed in. Both or neither: a half-set pair
# is a configuration mistake, and the failure it otherwise produces is the worst
# kind — the server comes up on plaintext while the operator believes it is
# encrypted. Say so and stop.
#
# ReplayWeb.page needs this more than most viewers. A service worker only
# registers in a secure context, and the whole viewer is a service worker: over
# plain http on a hostname the page renders and then never opens an archive.
# https — or localhost, which browsers treat as trustworthy — is the difference.
if [ -n "${TLS_CERT:-}" ] && [ -n "${TLS_KEY:-}" ]; then
  for f in "${TLS_CERT}" "${TLS_KEY}"; do
    [ -r "${f}" ] || { echo "FATAL: cannot read ${f}" >&2; exit 1; }
  done
  TLS_LISTEN="listen 443 ssl; http2 on; ssl_certificate ${TLS_CERT}; ssl_certificate_key ${TLS_KEY};"
elif [ -n "${TLS_CERT:-}${TLS_KEY:-}" ]; then
  echo "FATAL: TLS_CERT and TLS_KEY must be set together (only one was given)" >&2
  exit 1
else
  TLS_LISTEN=""
fi
export TLS_LISTEN

# Only these are substituted. nginx's own $variables must survive, so the names
# are listed explicitly rather than letting envsubst take every $token.
envsubst '$S3_BUCKET_URL $TLS_LISTEN' \
  < /etc/nginx/templates/replay.conf \
  > /etc/nginx/conf.d/default.conf

# nginx does not read /etc/resolv.conf; `resolver` has to name an address.
# Reading it from resolv.conf keeps this working on whatever DNS the platform
# hands the container.
#
# ipv6=off is not cosmetic. `getent hosts seaweedfs.browserhive` inside a
# container on this platform answers with an IPv6 address, and there is no v6
# route between the VMs — resolving v6-first sends every upstream request to
# an unreachable address. BrowserHive itself runs with
# --dns-result-order=ipv4first for the same reason.
resolver_addr=$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf)
if [ -n "${resolver_addr}" ]; then
  echo "resolver ${resolver_addr} valid=10s ipv6=off;" > /etc/nginx/conf.d/resolver.conf
else
  # No nameserver at all. Serving the viewer still works; only /wacz/ breaks,
  # and it would break anyway. Say so rather than failing to start.
  echo "WARN: no nameserver in /etc/resolv.conf; /wacz/ will not resolve" >&2
  : > /etc/nginx/conf.d/resolver.conf
fi

exec nginx -g 'daemon off;'
