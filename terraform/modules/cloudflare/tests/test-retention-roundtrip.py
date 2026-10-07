#!/usr/bin/env python3
"""Exercise real provider serialization against a local R2 API fixture only."""
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading

module_root = Path(__file__).resolve().parents[1]
terraform = os.environ.get('TERRAFORM_BIN', 'terraform')
rules = []
operations = []

class Handler(http.server.BaseHTTPRequestHandler):
    def respond(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'success': True, 'errors': [], 'messages': [], 'result': {'rules': rules}}).encode())

    def do_PUT(self):
        global rules
        operations.append('PUT')
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        rules = sorted(payload['rules'], key=lambda rule: rule['id'])
        # R2 omits unset transitions in its GET/PUT response.
        for rule in rules:
            for key in ('deleteObjectsTransition', 'abortMultipartUploadsTransition'):
                if rule.get(key) is None:
                    rule.pop(key, None)
        self.respond()

    def do_GET(self):
        operations.append('GET')
        self.respond()

    def log_message(self, *_):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix='retention-roundtrip-') as temp:
        fixture = Path(temp)
        for name in ('main.tf', 'variables.tf', 'versions.tf'):
            shutil.copyfile(module_root / 'modules/retention' / name, fixture / name)
        shutil.copyfile(module_root / '.terraform.lock.hcl', fixture / '.terraform.lock.hcl')
        (fixture / 'provider.tf').write_text('provider "cloudflare" {\n base_url = "http://127.0.0.1:' + str(server.server_port) + '/client/v4/"\n api_token = "' + 'x' * 40 + '"\n}\n')
        (fixture / 'terraform.tfvars.json').write_text(json.dumps({'account_id': '0' * 32, 'bucket_name': 'local-fixture', 'preview_retention_days': 1}))
        def run(*args, expected=0):
            result = subprocess.run([terraform, *args], cwd=fixture, capture_output=True, text=True)
            if result.returncode != expected:
                raise AssertionError(result.stdout + result.stderr)
            return result
        run('init', '-backend=false', '-input=false', '-lockfile=readonly')
        run('apply', '-auto-approve', '-input=false', '-no-color')
        assert len(rules) == 1
        assert rules[0]['deleteObjectsTransition']['condition']['maxAge'] == 86400
        assert rules[0]['abortMultipartUploadsTransition']['condition']['maxAge'] == 604800
        run('plan', '-input=false', '-no-color', '-detailed-exitcode')
        run('plan', '-input=false', '-no-color', '-detailed-exitcode')
        writes = operations.count('PUT')
        run('plan', '-input=false', '-no-color', '-detailed-exitcode', '-var=preview_retention_days=2', expected=2)
        assert operations.count('PUT') == writes
        assert operations.count('GET') >= 3
        print('Retention local API round-trip: apply, two no-change refreshed plans, and visible retention-change plan passed.')
finally:
    server.shutdown()
