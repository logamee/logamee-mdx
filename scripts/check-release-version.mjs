import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function checkReleaseVersion(root = process.cwd(), env = process.env) {
  const packageJson = await readJson(path.join(root, 'package.json'));
  const packageLock = await readJson(path.join(root, 'package-lock.json'));
  const cargoToml = await readFile(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
  const tauriConfig = await readJson(path.join(root, 'src-tauri', 'tauri.conf.json'));
  const packageHeader = cargoToml.match(/^\[package\][^\S\r\n]*(?:\r?\n|$)/m);
  let cargoPackage;
  if (packageHeader?.index !== undefined) {
    const packageBodyStart = packageHeader.index + packageHeader[0].length;
    const remaining = cargoToml.slice(packageBodyStart);
    const nextTable = remaining.search(/^\s*\[[^\]\r\n]+\]/m);
    const packageBody = nextTable === -1 ? remaining : remaining.slice(0, nextTable);
    cargoPackage = packageBody.match(/^\s*version\s*=\s*"([^"]+)"/m);
  }

  if (!cargoPackage) throw new Error('src-tauri/Cargo.toml: missing [package] version');
  const expected = packageJson.version;
  if (typeof expected !== 'string' || !SEMVER.test(expected)) {
    throw new Error(`package.json: invalid semantic version ${JSON.stringify(expected)}`);
  }

  const sources = [
    ['package-lock.json', packageLock.version],
    ['package-lock.json packages[""]', packageLock.packages?.['']?.version],
    ['src-tauri/Cargo.toml', cargoPackage[1]],
    ['src-tauri/tauri.conf.json', tauriConfig.version],
  ];
  for (const [file, version] of sources) {
    if (version !== expected) throw new Error(`${file}: expected ${expected}, found ${String(version)}`);
  }

  if (env.GITHUB_REF_TYPE === 'tag') {
    const tag = env.GITHUB_REF_NAME ?? '';
    if (!SEMVER.test(tag.slice(1)) || tag !== `v${expected}`) {
      throw new Error(`release tag must be v${expected}, found ${JSON.stringify(tag)}`);
    }
  }

  return expected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const version = await checkReleaseVersion();
    if (process.argv.includes('--github-output')) {
      const output = process.env.GITHUB_OUTPUT;
      if (!output) throw new Error('GITHUB_OUTPUT is required with --github-output');
      await appendFile(output, `version=${version}\n`, 'utf8');
    }
    console.log(`Release version ${version} is consistent.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
