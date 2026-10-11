#!/usr/bin/env python3
"""Fetch latest official core; stop if the reviewed wire/options contract changed."""
import argparse, hashlib, json, os, pathlib, re, urllib.request, zipfile, io

ROOT = pathlib.Path(__file__).resolve().parents[1]
API = 'https://api.github.com/repos/Genymobile/scrcpy/releases/'
SOURCES = {
    'Streamer.java': 'device/Streamer.java',
    'DesktopConnection.java': 'device/DesktopConnection.java',
    'ControlMessageReader.java': 'control/ControlMessageReader.java',
    'Options.java': 'Options.java',
}

def fetch(url, limit=4*1024*1024):
    headers = {'User-Agent': 'uficpy-core-builder', 'Accept': 'application/vnd.github+json'}
    if url.startswith('https://api.github.com/') and os.getenv('GH_TOKEN'):
        headers['Authorization'] = 'Bearer ' + os.environ['GH_TOKEN']
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError('Download exceeds expected size: ' + url)
    return data

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--version', default='latest', help='latest, locked, or exact official version')
    args = parser.parse_args()
    version = args.version
    if version == 'locked':
        version = json.loads((ROOT/'core-lock.json').read_text())['version']
    if version != 'latest' and not re.fullmatch(r'\d+\.\d+(?:\.\d+)?', version):
        raise ValueError('Invalid scrcpy version')
    release = json.loads(fetch(API + ('latest' if version == 'latest' else 'tags/v'+version)))
    tag = release['tag_name']
    if release.get('draft') or release.get('prerelease') or not re.fullmatch(r'v\d+\.\d+(?:\.\d+)?', tag):
        raise RuntimeError('Expected an official stable release')
    asset = next(a for a in release['assets'] if a['name'] == 'scrcpy-server-'+tag)
    digest = asset.get('digest', '')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
        raise RuntimeError('Official asset SHA-256 digest is missing; refusing unverified core')
    contract = json.loads((ROOT/'scripts/core-contract.json').read_text())
    changed = []
    for name, relative in SOURCES.items():
        source = fetch(f'https://raw.githubusercontent.com/Genymobile/scrcpy/{tag}/server/src/main/java/com/genymobile/scrcpy/{relative}')
        if hashlib.sha256(source).hexdigest() != contract['source_sha256'][name]:
            changed.append(name)
    if changed:
        raise RuntimeError('Latest scrcpy requires protocol/options review: '+', '.join(changed)+
                           '. Adapt code/tests and update scripts/core-contract.json; no release was published.')
    expected_url = f'https://github.com/Genymobile/scrcpy/releases/download/{tag}/scrcpy-server-{tag}'
    if asset['browser_download_url'] != expected_url:
        raise RuntimeError('Unexpected official download URL')
    jar = fetch(expected_url)
    if 'sha256:'+hashlib.sha256(jar).hexdigest() != digest:
        raise RuntimeError('Official core checksum mismatch')
    with zipfile.ZipFile(io.BytesIO(jar)) as archive:
        if 'classes.dex' not in archive.namelist() or archive.testzip():
            raise RuntimeError('Invalid Android server JAR')
    lock = {'version': tag[1:], 'sha256': digest[7:], 'source': release['html_url']}
    (ROOT/'scrcpy-server.jar').write_bytes(jar)
    (ROOT/'version.txt').write_text(tag[1:]+'\n')
    (ROOT/'core-lock.json').write_text(json.dumps(lock, indent=2)+'\n')
    print(f'Official scrcpy {tag}: checksum and reviewed source contract verified')

if __name__ == '__main__':
    main()
