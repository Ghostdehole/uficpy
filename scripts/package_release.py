#!/usr/bin/env python3
"""Package ARM64 and ARMv7 binaries with one immutable release manifest."""
import argparse, hashlib, json, pathlib, re, shutil, tarfile, zipfile, os
from plugin_source import write_index

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARCHITECTURES = {'arm64': (2, 183), 'armv7': (1, 40)}
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
    if a.tag in {'.', '..'} or not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}',a.tag) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',a.repository):
        raise ValueError('Invalid tag/repository')
    version=(ROOT/'VERSION').read_text().strip()
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?',version):
        raise ValueError('Invalid application version')
    plugin_name=f'uficpy_plugin-v{version}.js'
    dist=ROOT/'dist';stage=dist/'stage'
    binaries={}
    # Validate both builds before writing any release asset. A missing or stale
    # build must never leave a release that advertises the wrong architecture.
    for architecture,(elf_class,machine) in ARCHITECTURES.items():
        binary=dist/f'uficpy-{architecture}'
        if not binary.is_file():
            raise ValueError(f'Missing {architecture} binary: {binary.name}')
        with binary.open('rb') as source:
            elf=source.read(20)
        if len(elf)!=20 or elf[:6]!=b'\x7fELF'+bytes([elf_class,1]) or int.from_bytes(elf[18:20],'little')!=machine:
            raise ValueError(f'Expected Linux {architecture} little-endian ELF binary')
        binaries[architecture]=binary
    core=json.loads((ROOT/'core-lock.json').read_text())
    if json.loads((ROOT/'config.json').read_text()).get('token'):
        raise ValueError('Refusing to publish a config.json containing an access token')
    if (ROOT/'version.txt').read_text().strip()!=core['version']:
        raise ValueError('Core version.txt differs from build lock')
    if hashlib.sha256((ROOT/'scrcpy-server.jar').read_bytes()).hexdigest()!=core['sha256']:
        raise ValueError('Core differs from build lock')
    if stage.exists(): shutil.rmtree(stage)
    stage.mkdir(parents=True,exist_ok=True)
    assets={}
    for architecture,binary in binaries.items():
        directory=stage/architecture
        directory.mkdir()
        for name in FILES:
            shutil.copyfile(binary if name=='uficpy' else ROOT/name,directory/name)
            (directory/name).chmod(0o700 if name=='uficpy' or name.endswith('.sh') else 0o600)
        shutil.copytree(ROOT/'licenses',directory/'licenses',dirs_exist_ok=True)
        (directory/'release-tag.txt').write_text(a.tag+'\n')
        name=f'uficpy-{architecture}.tar.gz'
        with tarfile.open(dist/name,'w:gz') as archive:
            for file in sorted(directory.rglob('*')):
                if file.is_file():archive.add(file,arcname=file.relative_to(directory),recursive=False)
        assets[architecture]={'name':name,'sha256':hashlib.sha256((dist/name).read_bytes()).hexdigest(),'size':(dist/name).stat().st_size}
    for old in [dist/'uficpy_plugin.js', *dist.glob('uficpy_plugin-v*.js')]:
        old.unlink(missing_ok=True)
    shutil.copyfile(ROOT/'uficpy_plugin.js',dist/plugin_name)
    write_index(dist/plugin_name,f'https://github.com/{a.repository}/releases/download/{a.tag}',dist/'repo.json')
    write_index(ROOT/'uficpy_plugin.js',f'https://raw.githubusercontent.com/{a.repository}/main',ROOT/'repo.json')
    shutil.copyfile(ROOT/'core-lock.json',dist/'core-lock.json')
    assets['plugin']={'name':plugin_name,'sha256':hashlib.sha256((dist/plugin_name).read_bytes()).hexdigest(),'size':(dist/plugin_name).stat().st_size}
    manifest={'schema':1,'version':version,'tag':a.tag,'repository':a.repository,
              'scrcpy_version':core['version'],'assets':assets}
    (dist/'release.json').write_text(json.dumps(manifest,indent=2)+'\n')
    source_zip(dist/'uficpy-source.zip')
    # Keep the backend at its immutable release path. Only release.json is
    # replaced when the static mirror advances to a newer release.
    with zipfile.ZipFile(dist/'uficpy-mirror.zip','w',zipfile.ZIP_STORED) as archive:
        for architecture in ARCHITECTURES:
            name=assets[architecture]['name']
            archive.write(dist/name,f'releases/{a.tag}/{name}')
        archive.write(dist/'release.json','release.json')
    checks=[assets[architecture]['name'] for architecture in ARCHITECTURES]+[plugin_name,'repo.json','core-lock.json','release.json','uficpy-source.zip','uficpy-mirror.zip']
    (dist/'SHA256SUMS').write_text(''.join(hashlib.sha256((dist/f).read_bytes()).hexdigest()+'  '+f+'\n' for f in checks))
    print(json.dumps(manifest,indent=2))

if __name__=='__main__':main()
