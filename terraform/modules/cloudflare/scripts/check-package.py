#!/usr/bin/env python3
"""Validate an immutable local Git module package without an OSS checkout or cloud calls."""
import argparse
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--commit', required=True, help='Full 40-character local Git commit SHA')
parser.add_argument('--provider-version', default='5.26.0', choices=['5.24.0', '5.26.0'])
parser.add_argument('--terraform-bin', default='terraform')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]

def git(*argv):
    return subprocess.check_output(['git', '-C', str(repo), *argv])

# The package may be the repository root (generated package repository) or a subdirectory
# of a larger repository (the monorepo's terraform/modules/cloudflare).
toplevel = Path(git('rev-parse', '--show-toplevel').decode().strip())
subdir = git('rev-parse', '--show-prefix').decode().strip().strip('/')
git_source_base = 'git::' + toplevel.as_uri() + ('//' + subdir if subdir else '')

sha = git('rev-parse', '--verify', args.commit + '^{commit}').decode().strip()
if args.commit != sha:
    parser.error('--commit must be the full resolved commit SHA')
archive = git('archive', '--format=tar', sha)
required = ['README.md', 'LICENSE', 'main.tf', 'variables.tf', 'outputs.tf', 'versions.tf',
            'modules/delivery/main.tf', 'modules/delivery/README.md',
            'modules/retention/main.tf', 'modules/retention/README.md',
            'examples/local-consumer/main.tf', 'examples/registry-consumer/main.tf']
with tempfile.TemporaryDirectory(prefix='artifact-pages-package-') as work:
    root = Path(work)
    package = root / 'package'
    package.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        members = tar.getmembers()
        if any(m.issym() or m.islnk() or m.name.startswith('/') or '..' in Path(m.name).parts for m in members):
            raise SystemExit('Package contains a link or unsafe path')
        names = {m.name for m in members}
        missing = set(required) - names
        if missing:
            raise SystemExit('Missing package files: ' + ', '.join(sorted(missing)))
        if any('.terraform' in Path(n).parts or '.local' in Path(n).parts
               or '.tfstate' in Path(n).name or n.endswith(('.tfplan', '.tfvars', '.tfvars.json'))
               for n in names):
            raise SystemExit('Package contains generated or private Terraform data')
        tar.extractall(package)
    if 'MIT License' not in (package / 'LICENSE').read_text():
        raise SystemExit('Expected MIT license')

    def terraform(directory, *argv):
        subprocess.run([args.terraform_bin, '-chdir=' + str(directory), *argv], check=True)

    terraform(package, 'fmt', '-check', '-recursive')
    for directory in [package, package / 'examples/local-consumer']:
        terraform(directory, 'init', '-backend=false', '-input=false', '-lockfile=readonly')
        terraform(directory, 'validate')

    # Retrieve the exact commit using Terraform's Git downloader, not a copied module.
    consumer = root / 'consumer'
    consumer.mkdir()
    for name in ['main.tf', 'variables.tf', 'outputs.tf', 'versions.tf']:
        contents = (package / 'examples/registry-consumer' / name).read_text()
        if name == 'main.tf':
            contents = contents.replace('source  = "artifact-pages/artifact-pages/cloudflare"',
                                        'source = "' + git_source_base + '?ref=' + sha + '"')
            contents = contents.replace('  version = "0.1.0"\n', '')
        if name == 'versions.tf':
            contents = contents.replace('>= 5.24.0, < 6.0.0', '= ' + args.provider_version)
        (consumer / name).write_text(contents)
    terraform(consumer, 'init', '-backend=false', '-input=false')
    terraform(consumer, 'validate')
    modules = json.loads((consumer / '.terraform/modules/modules.json').read_text())['Modules']
    installed = next(m for m in modules if m['Key'] == 'artifact_pages')
    if installed['Source'] != git_source_base + '?ref=' + sha:
        raise SystemExit('Consumer did not resolve the requested immutable Git source')
    print(json.dumps({'tested_commit': sha, 'provider_version': args.provider_version,
                      'module_source': installed['Source'], 'package_files': len(names),
                      'result': 'passed; local Git retrieval only, no Registry or cloud proof'}, indent=2))
