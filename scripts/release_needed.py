#!/usr/bin/env python3
import json, os, pathlib, subprocess

needed = True
if os.environ.get('EVENT_NAME') == 'schedule':
    result = subprocess.run(['gh','api',f"repos/{os.environ['GITHUB_REPOSITORY']}/releases/latest"],capture_output=True,text=True)
    if result.returncode == 0:
        release=json.loads(result.stdout)
        tag=release['tag_name']
        current=pathlib.Path('version.txt').read_text().strip()
        version=pathlib.Path('VERSION').read_text().strip()
        # Retry a failed source/application update even when the core is unchanged.
        needed=not (tag.startswith(f'v{version}-scrcpy{current}-build.') and
                    release.get('target_commitish') == os.environ.get('GITHUB_SHA'))
with open(os.environ['GITHUB_OUTPUT'],'a') as output:
    output.write('needed='+str(needed).lower()+'\n')
print('Release needed:',needed)
