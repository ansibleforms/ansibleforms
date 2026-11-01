#!/bin/bash
#
# Build the release bundle: AnsibleForms built and ready to run with Node.js, for the
# installer's native mode (a controller or a Runner directly on a server, no containers).
# Usage: ./scripts/build-bundle.sh <version> [out-dir]
#
# Arguments:
#   version:  the version the build reports, e.g. 7.3.0
#   out-dir:  (optional) where the bundle and its checksum go, ./dist by default
#
# It builds what the images build, from the files git tracks (never a local .env or
# persistent folder), for the architecture it runs on (amd64 or arm64): node-jq and bcrypt
# bring native binaries, so each architecture is built on its own machine.
#
#   ansibleforms-<version>-linux-<arch>.tar.gz
#     ansibleforms/server/         the server with its production modules and the built client
#                                  in views/, as /app/dist in the ansibleforms image
#     ansibleforms/bin/ytt         ytt, at the version and checksum of docker/controller/Dockerfile
#     ansibleforms/rte/            the python requirements and collections of the RTE images
#     ansibleforms/versions.env    the Node.js major (.nvmrc), and the Python and uv versions
#                                  of docker/runner/rte-core/Dockerfile, which the installer installs
#   ansibleforms-<version>-linux-<arch>.tar.gz.sha256

set -euo pipefail

VERSION="${1:?usage: build-bundle.sh <version> [out-dir]}"
OUT="$(mkdir -p "${2:-dist}" && cd "${2:-dist}" && pwd)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ─── the architecture and the versions ───────────────────────────────────────

case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) echo "no bundle for $(uname -m)" >&2; exit 1 ;;
esac

# one source for each version: the files the images are built from
arg() { sed -n "s/^ARG $1=//p" "$2" | head -1; }
NODE_MAJOR="$(tr -d '[:space:]v' < .nvmrc)"
PYTHON_VERSION="$(arg PYTHON_VERSION docker/runner/rte-core/Dockerfile)"
UV_VERSION="$(sed -n 's#^FROM ghcr.io/astral-sh/uv:\([0-9.]*\).*#\1#p' docker/runner/rte-core/Dockerfile | head -1)"
YTT_VERSION="$(arg YTT_VERSION docker/controller/Dockerfile)"
YTT_SHA256="$(arg "YTT_SHA256_${ARCH^^}" docker/controller/Dockerfile)"
for v in NODE_MAJOR PYTHON_VERSION UV_VERSION YTT_VERSION YTT_SHA256; do
  [ -n "${!v}" ] || { echo "could not read $v" >&2; exit 1; }
done
GIT_SHA="$(git rev-parse --short=7 HEAD)"
BUILD_TIME="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
echo "Bundle $VERSION for linux-$ARCH (Node.js $NODE_MAJOR, Python $PYTHON_VERSION, uv $UV_VERSION)"

# ─── a clean copy of what git tracks ─────────────────────────────────────────

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git ls-files -z client server scripts | tar --null -T - -cf - | tar -xf - -C "$WORK"

# ─── build, as the Dockerfile does ───────────────────────────────────────────

# the client, into static files
(
  cd "$WORK/client"
  npm ci
  "$ROOT/scripts/generate-build-info.sh" . "$GIT_SHA" "$BUILD_TIME" "$VERSION"
  npm run build
)

# the server, with its production modules only
(
  cd "$WORK/server"
  npm ci --omit=dev
  "$ROOT/scripts/generate-build-info.sh" . "$GIT_SHA" "$BUILD_TIME" "$VERSION"
  rm -f .env.*
  rm -rf views persistent
  mkdir views
  cp -r ../client/dist/. views/
)

# ─── the bundle ──────────────────────────────────────────────────────────────

STAGE="$WORK/stage/ansibleforms"
mkdir -p "$STAGE/bin" "$STAGE/rte"
mv "$WORK/server" "$STAGE/server"

curl -fsSL -o "$STAGE/bin/ytt" "https://github.com/carvel-dev/ytt/releases/download/v${YTT_VERSION}/ytt-linux-${ARCH}"
echo "$YTT_SHA256  $STAGE/bin/ytt" | sha256sum -c -
chmod +x "$STAGE/bin/ytt"

cp docker/runner/rte-core/requirements.txt "$STAGE/rte/requirements-core.txt"
cp docker/runner/rte-full/requirements.txt "$STAGE/rte/requirements-full.txt"
cp docker/runner/rte-full/collections.yml "$STAGE/rte/collections.yml"

cat > "$STAGE/versions.env" <<EOF
VERSION=$VERSION
NODE_MAJOR=$NODE_MAJOR
PYTHON_VERSION=$PYTHON_VERSION
UV_VERSION=$UV_VERSION
EOF

NAME="ansibleforms-${VERSION}-linux-${ARCH}.tar.gz"
tar -C "$WORK/stage" --owner=0 --group=0 -czf "$OUT/$NAME" ansibleforms
(cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256" && cat "$NAME.sha256")
echo "Built $OUT/$NAME ($(du -h "$OUT/$NAME" | cut -f1))"
