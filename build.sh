#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
GO=${GO:-go}
sh scripts/test.sh
APP_VERSION=$(cat VERSION)
mkdir -p dist
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 "$GO" build -buildvcs=false -trimpath -ldflags="-s -w -X main.appVersion=$APP_VERSION" -o dist/uficpy-arm64 .
CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 "$GO" build -buildvcs=false -trimpath -ldflags="-s -w -X main.appVersion=$APP_VERSION" -o dist/uficpy-armv7 .
python3 scripts/package_release.py --tag "v$APP_VERSION-local"
