import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function markdownBytes(targetBytes, block) {
  const chunks = ['# mdx deterministic benchmark\n\n'];
  let size = Buffer.byteLength(chunks[0]);
  for (let index = 0; size < targetBytes; index += 1) {
    const chunk = block(index);
    chunks.push(chunk);
    size += Buffer.byteLength(chunk);
  }
  return chunks.join('');
}

function scene(count) {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'mmd-professional-benchmark-v1',
    elements: Array.from({ length: count }, (_, index) => ({
      id: `mmd-benchmark-${String(index).padStart(4, '0')}`,
      type: 'rectangle',
      x: (index % 25) * 120,
      y: Math.floor(index / 25) * 90,
      width: 96,
      height: 64,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: `a${index.toString(36).padStart(4, '0')}`,
      roundness: { type: 3 },
      seed: index + 7417,
      version: 1,
      versionNonce: index + 17041,
      isDeleted: false,
      boundElements: [],
      updated: 1,
      link: null,
      locked: false,
    })),
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files: {},
  };
}

export async function generateProfessionalFixtures(outputDirectory) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const files = new Map();
  files.set('markdown-1mb.md', markdownBytes(1024 * 1024, (index) => `## Section ${index}\n\nDeterministic paragraph with **bold**, [link](./asset.png), and value ${index}.\n\n`));
  files.set('markdown-5mb.md', markdownBytes(5 * 1024 * 1024, (index) => `## Large section ${index}\n\n| key | value |\n| --- | --- |\n| ${index} | deterministic markdown content |\n\n`));
  files.set('markdown-content-heavy.md', markdownBytes(1024 * 1024, (index) => `## Heavy ${index}\n\n\`\`\`typescript\nconst value${index}: number = ${index};\n\`\`\`\n\n$$\\sum_{i=0}^{${index % 100}} i$$\n\n\`\`\`mermaid\ngraph LR\nA${index} --> B${index}\n\`\`\`\n\n`));
  for (const count of [100, 500, 1000]) files.set(`excalidraw-${count}.excalidraw`, `${JSON.stringify(scene(count))}\n`);
  const manifest = { schemaVersion: 1, files: {} };
  for (const [name, content] of files) {
    await fs.writeFile(path.join(outputDirectory, name), content);
    manifest.files[name] = { bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') };
  }
  await fs.writeFile(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const output = process.argv[2];
  if (!output) throw new Error('usage: generate-professional-fixtures <directory>');
  await generateProfessionalFixtures(output);
}
