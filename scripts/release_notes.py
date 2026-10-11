#!/usr/bin/env python3
"""Use the current changelog entry as the release description."""
import json
import pathlib
import re


def release_notes(manifest, changelog):
    version = re.escape(manifest['version'])
    match = re.search(r'^## '+version+r'\s*\n(.*?)(?=^## |\Z)', changelog, re.M | re.S)
    if not match or not match[1].strip():
        raise ValueError('Missing changelog entry for '+manifest['version'])
    return match[1].strip()+'\n\nscrcpy '+manifest['scrcpy_version']+'\n'


if __name__ == '__main__':
    root = pathlib.Path(__file__).resolve().parents[1]
    manifest = json.loads((root/'dist/release.json').read_text())
    print(release_notes(manifest, (root/'CHANGELOG.md').read_text(encoding='utf-8')), end='')
