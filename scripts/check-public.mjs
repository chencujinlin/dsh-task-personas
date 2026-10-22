import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const skipped = new Set(['.git', 'node_modules', 'output']);
const forbiddenNames = /^(?:qa|backups|\.env(?:\..*)?|sessions\.json|social\.json|channels\.json|library\.json|seen\.json|gateway\.log.*)$/i;
const privateText = /(?:\/Users\/|[A-Z]:\\Users\\|oc_[a-f0-9]{24,}|ou_[a-f0-9]{24,}|cli_[a-f0-9]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,})/;
const findings = [];
function walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (skipped.has(ent.name)) continue;
    const path = join(dir, ent.name), name = relative(root, path);
    if (ent.isSymbolicLink()) { findings.push(`${name}: symlink`); continue; }
    if (forbiddenNames.test(ent.name) || /\.(?:tgz|log|pem|key|p12|sqlite|db|map)$/.test(ent.name)) findings.push(`${name}: runtime/private artifact`);
    if (ent.isDirectory()) walk(path);
    else if (/\.(?:js|mjs|ts|json|md|yml|yaml)$/.test(ent.name) && privateText.test(readFileSync(path, 'utf8'))) findings.push(`${name}: private identifier/path/key pattern`);
  }
}
walk(root);
const source = JSON.parse(readFileSync(join(root, 'roles/source.json'), 'utf8'));
for (const [file, expected] of Object.entries(source.sha256)) {
  const actual = createHash('sha256').update(readFileSync(join(root, 'roles/upstream', file))).digest('hex');
  if (actual !== expected) findings.push(`roles/upstream/${file}: upstream checksum mismatch`);
}
if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
else console.log('Public tree checks passed; upstream role cards match their recorded hashes. Run an independent secret scanner before publishing.');
