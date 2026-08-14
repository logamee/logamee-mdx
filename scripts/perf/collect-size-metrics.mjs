import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

async function sizeOf(target) {
  const info = await fs.stat(target);
  if (info.isFile()) return info.size;
  const entries = await fs.readdir(target, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => sizeOf(path.join(target, entry.name))))).reduce((sum, size) => sum + size, 0);
}

export async function collectSizeMetrics({ appPath, frontendPath, installerPath, projectRoot }) {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const dependencySizes = await Promise.all(Object.keys(packageJson.dependencies ?? {}).map((name) => sizeOf(path.join(projectRoot, 'node_modules', name))));
  return {
    'size.appBytes': await sizeOf(appPath),
    'size.frontendBytes': await sizeOf(frontendPath),
    'size.installerBytes': await sizeOf(installerPath),
    'size.largestDependencyBytes': Math.max(0, ...dependencySizes),
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const [projectRoot, appPath, installerPath, frontendPath, output] = process.argv.slice(2);
  if (!output) throw new Error('usage: collect-size-metrics <project-root> <app> <installer> <frontend> <output.json>');
  await fs.writeFile(output, `${JSON.stringify(await collectSizeMetrics({ projectRoot, appPath, installerPath, frontendPath }), null, 2)}\n`);
}
