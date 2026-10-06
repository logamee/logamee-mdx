// Informational hotspot report: ranks source files by commit churn weighted
// by current size, so the most-touched and largest files get review priority
// (the "hotspot check" contract in AGENTS.md). This is a report, not a gate.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// git numstat renders renames as "src/{old => new}.ts".
export function normalizeRenamedPath(rawPath) {
  return rawPath.replace(/\{[^}]*=>\s*/, '').replace(/\}/g, '');
}

// Parses `git log --numstat --format=%H` output. Each numstat line belongs to
// one commit, and a file appears at most once per commit, so counting lines
// per path equals the number of commits that touched it.
export function parseGitLogNumstat(text) {
  const stats = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) continue;
    const file = normalizeRenamedPath(match[3]);
    const added = match[1] === '-' ? 0 : Number(match[1]);
    const deleted = match[2] === '-' ? 0 : Number(match[2]);
    const entry = stats.get(file) ?? { commits: 0, churn: 0 };
    entry.commits += 1;
    entry.churn += added + deleted;
    stats.set(file, entry);
  }
  return stats;
}

function currentLineCount(root, file) {
  const full = path.join(root, file);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return 0;
  return fs.readFileSync(full, 'utf8').split('\n').length;
}

export function computeHotspots({ stats, root = repoRoot, topN = 15 }) {
  const rows = [];
  for (const [file, entry] of stats) {
    if (!/\.(ts|tsx|rs|css)$/.test(file)) continue;
    const lines = currentLineCount(root, file);
    if (lines === 0) continue;
    rows.push({
      file,
      commits: entry.commits,
      churn: entry.churn,
      lines,
      score: entry.commits * lines,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, topN);
}

export function formatHotspotTable(rows) {
  const header = 'commits  lines  score  file';
  const body = rows.map(
    (row) =>
      `${String(row.commits).padStart(6)}  ${String(row.lines).padStart(5)}  ${String(row.score).padStart(5)}  ${row.file}`,
  );
  return [header, ...body].join('\n');
}

export async function collectHotspots({
  root = repoRoot,
  gitLogText,
  topN = 15,
  exec = execFileAsync,
} = {}) {
  const text =
    gitLogText ??
    (
      await exec('git', ['log', '--numstat', '--no-merges', '--format=%H'], {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  return computeHotspots({ stats: parseGitLogNumstat(text), root, topN });
}

async function main() {
  const topN = Number(process.argv[2] ?? 15);
  const rows = await collectHotspots({ topN });
  console.log('Hotspot report (commits × current lines), informational only:');
  console.log(formatHotspotTable(rows));
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
