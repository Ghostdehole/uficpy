#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
GO=${GO:-go}
export GO
"$GO" test -buildvcs=false -race ./...
"$GO" vet -buildvcs=false ./...
node --test tests/*.test.mjs
node --check uficpy_plugin.js
node --check web/player.mjs
sh -n service.sh
sh -n install.sh
sh -n uninstall.sh
python3 -m unittest discover -s tests -p 'test_*.py'
"$GO" test -buildvcs=false -c -o fixture-server
node tests/browser.cjs
