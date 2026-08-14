import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_VERSION = 1;
export const DEFAULT_SEED = 7417;

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function documentContent(index, random) {
  const tags = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
  const tag = tags[Math.floor(random() * tags.length)];
  const paragraphCount = 2 + Math.floor(random() * 5);
  const paragraphs = Array.from({ length: paragraphCount }, (_, paragraph) => (
    `Paragraph ${paragraph + 1} contains ${tag}, token-${Math.floor(random() * 10_000)}, `
      + 'and deterministic Markdown search text.'
  ));
  return `# Document ${index}\n\ncategory: ${tag}\n\n${paragraphs.join('\n\n')}\n`;
}

export async function generateFixture({ outputDirectory, fileCount, seed = DEFAULT_SEED }) {
  if (!Number.isSafeInteger(fileCount) || fileCount < 1) {
    throw new Error('fileCount must be a positive safe integer');
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error('seed must be an unsigned 32-bit integer');
  }

  const random = seededRandom(seed);
  const corpusHash = createHash('sha256');
  const files = [];
  let indexedMarkdownBytes = 0;
  await mkdir(outputDirectory, { recursive: true });

  for (let index = 0; index < fileCount; index += 1) {
    const relativePath = `documents/${String(index).padStart(6, '0')}.md`;
    const content = documentContent(index, random);
    const bytes = Buffer.from(content);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const absolutePath = path.join(outputDirectory, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
    corpusHash.update(relativePath).update('\0').update(bytes).update('\0');
    indexedMarkdownBytes += bytes.length;
    files.push({ path: relativePath, bytes: bytes.length, digest });
  }

  const manifest = {
    fixtureVersion: FIXTURE_VERSION,
    seed,
    fileCount,
    corpusDigest: corpusHash.digest('hex'),
    indexedMarkdownBytes,
    files,
  };
  await writeFile(
    path.join(outputDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

async function main() {
  const outputDirectory = process.argv[2];
  const fileCount = Number(process.argv[3]);
  const seed = process.argv[4] === undefined ? DEFAULT_SEED : Number(process.argv[4]);
  if (!outputDirectory) throw new Error('Usage: generate-fixtures.mjs <output-directory> <file-count> [seed]');
  const manifest = await generateFixture({ outputDirectory, fileCount, seed });
  process.stdout.write(`${JSON.stringify({
    fixtureVersion: manifest.fixtureVersion,
    seed: manifest.seed,
    fileCount: manifest.fileCount,
    corpusDigest: manifest.corpusDigest,
    indexedMarkdownBytes: manifest.indexedMarkdownBytes,
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
