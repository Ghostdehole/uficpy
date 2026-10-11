#!/usr/bin/env python3
"""Package already-built ARM64 binary and publish an immutable release manifest."""
import argparse, hashlib, json, pathlib, re, shutil, tarfile, zipfile, os
from plugin_source import write_index

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILES = ['uficpy','scrcpy-server.jar','core-lock.json','version.txt','VERSION','config.json',
         'service.sh','install.sh','uninstall.sh','uficpy_plugin.js','README.md','THIRD_PARTY_NOTICES.md']
SOURCE_DIRS = {'.github', 'docs', 'licenses', 'scripts', 'tests', 'web'}
SOURCE_FILES = {'.gitattributes', '.gitignore', 'VERSION', 'README.md', 'CHANGELOG.md',
                'THIRD_PARTY_NOTICES.md', 'go.mod', 'go.sum', 'config.json', 'core-lock.json',
                'package.json', 'package-lock.json', 'repo.json', 'version.txt', 'scrcpy-server.jar'}

def source_zip(destination):
    # Capture the updated core lock used for this build; a scheduled release's
    # checked-out commit may still carry the previous core lock.
    with zipfile.ZipFile(destination,'w',zipfile.ZIP_DEFLATED) as archive:
        for parent,dirs,files in os.walk(ROOT):
            if pathlib.Path(parent) == ROOT:
                dirs[:]=sorted(d for d in dirs if d in SOURCE_DIRS)
            dirs[:]=sorted(d for d in dirs if d not in {'.git','dist','node_modules','__pycache__','test-results'})
            for name in sorted(files):
                file=pathlib.Path(parent)/name
                if file.parent == ROOT and name not in SOURCE_FILES and file.suffix not in {'.go', '.sh', '.js'}:
                    continue
                if file.is_symlink() or name in {'uficpy','uficpy-host','fixture-server','config.local.json'} or name.endswith(('.log','.pid','.ready','.pyc')):
                    continue
                archive.write(file,pathlib.Path('uficpy')/file.relative_to(ROOT))

def main():
    p=argparse.ArgumentParser();p.add_argument('--tag',required=True);p.add_argument('--repository',default='Ghostdehole/uficpy');a=p.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}',a.tag) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',a.repository):
        raise ValueError('Invalid tag/repository')
    version=(ROOT/'VERSION').read_text().strip()
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?',version):
        raise ValueError('Invalid application version')
    plugin_name=f'uficpy_plugin-v{version}.js'
    dist=ROOT/'dist';stage=dist/'stage'
    if stage.exists(): shutil.rmtree(stage)
    stage.mkdir(parents=True,exist_ok=True)
    binary=dist/'uficpy'
    with binary.open('rb') as source:
        elf=source.read(20)
    if elf[:6]!=b'\x7fELF\x02\x01' or int.from_bytes(elf[18:20],'little')!=183:
        raise ValueError('Expected Linux ARM64 ELF binary')
    core=json.loads((ROOT/'core-lock.json').read_text())
    if json.loads((ROOT/'config.json').read_text()).get('token'):
        raise ValueError('Refusing to publish a config.json containing an access token')
    if (ROOT/'version.txt').read_text().strip()!=core['version']:
        raise ValueError('Core version.txt differs from build lock')
    if hashlib.sha256((ROOT/'scrcpy-server.jar').read_bytes()).hexdigest()!=core['sha256']:
        raise ValueError('Core differs from build lock')
    for name in FILES:
        shutil.copyfile(binary if name=='uficpy' else ROOT/name,stage/name)
        (stage/name).chmod(0o700 if name=='uficpy' or name.endswith('.sh') else 0o600)
    shutil.copytree(ROOT/'licenses',stage/'licenses',dirs_exist_ok=True)
    (stage/'release-tag.txt').write_text(a.tag+'\n')
    name='uficpy-arm64.tar.gz'
    with tarfile.open(dist/name,'w:gz') as archive:
        for file in sorted(stage.rglob('*')):
            if file.is_file():archive.add(file,arcname=file.relative_to(stage),recursive=False)
    for old in [dist/'uficpy_plugin.js', *dist.glob('uficpy_plugin-v*.js')]:
        old.unlink(missing_ok=True)
    shutil.copyfile(ROOT/'uficpy_plugin.js',dist/plugin_name)
    write_index(dist/plugin_name,f'https://github.com/{a.repository}/releases/download/{a.tag}',dist/'repo.json')
    write_index(ROOT/'uficpy_plugin.js',f'https://raw.githubusercontent.com/{a.repository}/main',ROOT/'repo.json')
    shutil.copyfile(ROOT/'core-lock.json',dist/'core-lock.json')
    checksum=hashlib.sha256((dist/name).read_bytes()).hexdigest()
    manifest={'schema':1,'version':version,'tag':a.tag,'repository':a.repository,
              'scrcpy_version':core['version'],'assets':{
                  'arm64':{'name':name,'sha256':checksum,'size':(dist/name).stat().st_size},
                  'plugin':{'name':plugin_name,'sha256':hashlib.sha256((dist/plugin_name).read_bytes()).hexdigest(),'size':(dist/plugin_name).stat().st_size}}}
    (dist/'release.json').write_text(json.dumps(manifest,indent=2)+'\n')
    source_zip(dist/'uficpy-source.zip')
    checks=['uficpy-arm64.tar.gz',plugin_name,'repo.json','core-lock.json','release.json','uficpy-source.zip']
    (dist/'SHA256SUMS').write_text(''.join(hashlib.sha256((dist/f).read_bytes()).hexdigest()+'  '+f+'\n' for f in checks))
    print(json.dumps(manifest,indent=2))

if __name__=='__main__':main()
