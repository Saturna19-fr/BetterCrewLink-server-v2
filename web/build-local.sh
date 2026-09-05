#!/usr/bin/env bash
# Builds the web client outside Docker, into ../webclient, for local testing.
# The Docker build in web/Dockerfile does exactly the same steps -- keep them in sync.
set -euo pipefail

# Git Bash on Windows rewrites any argument that looks like a POSIX path into a
# Windows one, which turns --base-href /app/ into C:/Program Files/Git/app/ and
# produces a bundle that loads nothing. Harmless everywhere else.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

UPSTREAM=https://github.com/OhMyGuus/BetterCrewlink-mobile.git
# Pinned: patches in web/patches/ are written against this exact tree.
COMMIT=8bc441fee5424c82431fc7b0c6fc73ff3ea99858

here="$(cd "$(dirname "$0")" && pwd)"
build="$here/.build"
out="$here/../webclient"

rm -rf "$build/app"
mkdir -p "$build"
git clone -q "$UPSTREAM" "$build/app"
cd "$build/app"
git -c advice.detachedHead=false checkout -q "$COMMIT"

for p in "$here"/patches/*.patch; do
	echo "applying $(basename "$p")"
	git apply "$p"
done

# The Capacitor plugin is a file: dependency whose entry point is dist/, which
# upstream does not commit -- game-helper.service.ts will not resolve without it.
echo "building bcl-mobile-overlay"
(cd plugins/bcl-mobile-overlay && npm ci --ignore-scripts && npm run build)

echo "installing app dependencies"
npm ci --ignore-scripts

echo "building"
npx ng build --configuration production --base-href /app/

rm -rf "$out"
mkdir -p "$out"
cp -r www/. "$out/"
echo "built into $out"
