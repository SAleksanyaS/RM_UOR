#!/bin/sh
set -eu
uor_launcher_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -x "$uor_launcher_root/runtime/node/bin/node" ]; then
  exec "$uor_launcher_root/runtime/node/bin/node" "$uor_launcher_root/start-rm-uor.mjs" "$@"
fi
if command -v node >/dev/null 2>&1; then
  exec node "$uor_launcher_root/start-rm-uor.mjs" "$@"
fi
printf '%s\n' 'РМ УОР: нужен подготовленный ИТ дистрибутив с Node.js 22.16.0.' >&2
exit 1
