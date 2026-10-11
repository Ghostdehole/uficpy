#!/usr/bin/env python3
"""Generate the UFI-TOOLS plugin-store index, separate from release.json."""
import argparse
import datetime
import hashlib
import json
import pathlib
from urllib.parse import urlsplit

ROOT = pathlib.Path(__file__).resolve().parents[1]


def generate(plugin, download_url):
    url = urlsplit(download_url)
    if url.scheme != 'https' or not url.netloc or url.username or url.password or url.query or url.fragment:
        raise ValueError('download_url must be an HTTPS directory URL')
    if plugin.name != 'uficpy_plugin.js' or not plugin.is_file():
        raise ValueError('Expected the actual uficpy_plugin.js file')
    data = plugin.read_bytes()
    modified = datetime.datetime.fromtimestamp(plugin.stat().st_mtime, datetime.timezone.utc).isoformat(timespec='seconds')
    item = {'name': plugin.name, 'modified': modified, 'size': len(data), 'is_dir': False,
            'hash_info': {'md5': hashlib.md5(data, usedforsecurity=False).hexdigest()}}
    return {'download_url': download_url.rstrip('/'),
            'res': {'code': 200, 'message': 'success', 'data': {'content': [item], 'total': 1}}}


def write_index(plugin, download_url, output):
    output.write_text(json.dumps(generate(plugin, download_url), ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download-url', default='https://raw.githubusercontent.com/Ghostdehole/uficpy/main')
    parser.add_argument('--output', type=pathlib.Path, default=ROOT/'repo.json')
    args = parser.parse_args()
    write_index(ROOT/'uficpy_plugin.js', args.download_url, args.output)
