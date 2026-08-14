import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function describe(directory, name) {
  if (name !== path.basename(name)) throw new Error(`payload must be a basename: ${name}`);
  const file = path.join(directory, name);
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`payload is not a regular file: ${name}`);
  return { name, size: info.size, sha256: await sha256(file) };
}

async function createManifest(directory, names) {
  if (names.length === 0 || new Set(names).size !== names.length) throw new Error('payload names must be unique and non-empty');
  const files = [];
  for (const name of [...names].sort()) files.push(await describe(directory, name));
  const manifest = {
    schema: 1,
    runId: process.env.GITHUB_RUN_ID ?? 'local',
    job: process.env.GITHUB_JOB ?? 'local',
    files,
  };
  await writeFile(path.join(directory, 'artifact-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function verifyManifest(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'artifact-manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('invalid artifact manifest schema');
  }
  const names = manifest.files.map((file) => file.name);
  if (new Set(names).size !== names.length) throw new Error('artifact manifest contains duplicate names');
  const actualNames = (await readdir(directory)).sort();
  const expectedNames = [...names, 'artifact-manifest.json'].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`artifact file set mismatch: expected ${expectedNames.join(', ')}, found ${actualNames.join(', ')}`);
  }
  for (const expected of manifest.files) {
    const actual = await describe(directory, expected.name);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      throw new Error(`artifact integrity mismatch: ${expected.name}`);
    }
  }
  return manifest;
}

const [command, directory, ...names] = process.argv.slice(2);
try {
  if (command === 'create' && directory) await createManifest(directory, names);
  else if (command === 'verify' && directory && names.length === 0) await verifyManifest(directory);
  else throw new Error('usage: artifact-manifest.mjs create <directory> <file...> | verify <directory>');
  console.log(`Artifact manifest ${command} succeeded for ${directory}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
