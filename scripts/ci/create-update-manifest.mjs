import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repository = 'https://github.com/sunlin92/logamee-mdx/releases/latest/download';

function artifactNames(version) {
  return {
    'darwin-aarch64': `mdx_${version}_darwin-aarch64.app.tar.gz`,
    'darwin-x86_64': `mdx_${version}_darwin-x86_64.app.tar.gz`,
    'linux-x86_64': `mdx_${version}_linux-x86_64.AppImage.tar.gz`,
    'windows-x86_64': `mdx_${version}_windows-x86_64.nsis.zip`,
  };
}

export function createUpdateManifest({ version, publishedAt, notes, signatures }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('invalid version');
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error('invalid publication date');
  const names = artifactNames(version);
  const expected = new Set(Object.values(names).map((name) => `${name}.sig`));
  for (const signatureName of expected) {
    if (!signatures.get(signatureName)?.trim()) throw new Error(`missing signature: ${signatureName}`);
  }
  for (const signatureName of signatures.keys()) {
    if (!expected.has(signatureName)) throw new Error(`unexpected signature: ${signatureName}`);
  }
  return {
    version,
    notes,
    pub_date: new Date(publishedAt).toISOString(),
    platforms: Object.fromEntries(Object.entries(names).map(([target, name]) => [target, {
      signature: signatures.get(`${name}.sig`).trim(),
      url: `${repository}/${name}`,
    }])),
  };
}

function main() {
  const [directory, version, publishedAt] = process.argv.slice(2);
  if (!directory || !version || !publishedAt) throw new Error('usage: create-update-manifest <directory> <version> <published-at>');
  const signatures = new Map(fs.readdirSync(directory)
    .filter((name) => name.endsWith('.sig'))
    .map((name) => [name, fs.readFileSync(path.join(directory, name), 'utf8')]));
  const manifest = createUpdateManifest({ version, publishedAt, notes: 'Verified mdx desktop update.', signatures });
  fs.writeFileSync(path.join(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) main();
