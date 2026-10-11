#!/usr/bin/env python3
import json,pathlib,os
m=json.loads(pathlib.Path('dist/release.json').read_text())
print(f'''uficpy {m['version']} / official scrcpy {m['scrcpy_version']}

Commit: {os.getenv('GITHUB_SHA','local')}

- Import `uficpy_plugin.js` in UFI-TOOLS, then click 安装 / 更新.
- Android ARM64 + Root. The device must be able to reach GitHub over HTTPS.
- Reproducible source snapshot including the selected core: `uficpy-source.zip`.
- Backend asset: `uficpy-arm64.tar.gz`; verified manifest: `release.json`.
- UFI plugin-store source: `repo.json` (use the UFI proxy option for cross-origin requests).
- Upgrade preserves configuration/token; 全新安装 resets them.
- H.264 video, touch, scrolling and keyboard control; volume controls are opt-in in advanced settings.
- Audio, HEVC/AV1, HDR and lossless streaming are not implemented.
- Passed CI protocol, concurrency, media and Chromium tests; Android firmware and iPhone Safari still require device acceptance.
- scrcpy core and backend must be updated together. Check `core-lock.json` for the exact official asset SHA-256.
''')
