#!/bin/sh
# Render replay.conf, teach nginx how to resolve names, then hand over.
set -eu

# The upstream is configurable because this image is not BrowserHive-specific:
# any S3-compatible store with anonymous read on the bucket will do.
: "${S3_HOST:=seaweedfs.browserhive:8333}"
: "${S3_BUCKET:=browserhive}"
export S3_HOST S3_BUCKET

# Only these two are substituted. nginx's own $variables must survive, so the
# names are listed explicitly rather than letting envsubst take every $token.
envsubst '$S3_HOST $S3_BUCKET' \
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
