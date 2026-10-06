// Pre-commit helper for the "single commit around 400 changed lines" habit
// in AGENTS.md. Generated artifacts and lockfiles are excluded. Crossing the
// warn threshold only prints guidance; crossing the fail threshold blocks
// the commit (bypass deliberately with git commit --no-verify).
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const WARN_THRESHOLD = 400;
export const FAIL_THRESHOLD = 800;

const EXCLUDED_PATTERNS = [
  /^package-lock\.json$/,
  /^(dist|coverage|src-tauri\/target)\//,
];

function isExcluded(file) {
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(file));
}

export function parseStagedNumstat(text) {
  const files = [];
  const excluded = [];
  let totalLines = 0;
  for (const line of text.split('\n')) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) continue;
    const file = match[3].replace(/\{[^}]*=>\s*/, '').replace(/\}/g, '');
    const added = match[1] === '-' ? 0 : Number(match[1]);
    const deleted = match[2] === '-' ? 0 : Number(match[2]);
    const lines = added + deleted;
    if (lines === 0) continue;
    if (isExcluded(file)) {
      excluded.push(file);
      continue;
    }
    files.push({ file, lines });
    totalLines += lines;
  }
  files.sort((a, b) => b.lines - a.lines);
  return { files, excluded, totalLines };
}

export function evaluateCommitSize(
  totalLines,
  { warnThreshold = WARN_THRESHOLD, failThreshold = FAIL_THRESHOLD } = {},
) {
  if (totalLines > failThreshold) {
    return { status: 'fail', totalLines };
  }
  if (totalLines > warnThreshold) {
    return { status: 'warn', totalLines };
  }
  return { status: 'ok', totalLines };
}

export async function runCheck({ cwd = process.cwd(), exec = execFileAsync } = {}) {
  const { stdout } = await exec('git', ['diff', '--cached', '--numstat'], { cwd });
  const { files, excluded, totalLines } = parseStagedNumstat(stdout);
  const verdict = evaluateCommitSize(totalLines);
  return { ...verdict, files, excluded };
}

async function main() {
  const { status, totalLines, files, excluded } = await runCheck({ cwd: repoRoot });
  if (excluded.length > 0) {
    console.log(`excluded generated/lockfile paths: ${excluded.length}`);
  }
  if (status === 'ok') {
    console.log(`staged changes: ${totalLines} line(s)`);
    return 0;
  }
  const largest = files
    .slice(0, 3)
    .map((entry) => `  ${entry.lines}  ${entry.file}`)
    .join('\n');
  const detail = largest.length > 0 ? `largest staged files:\n${largest}\n` : '';
  if (status === 'warn') {
    console.warn(
      `staged changes are ${totalLines} line(s); the convention is around ` +
        `${WARN_THRESHOLD}. Consider splitting this commit.\n${detail}`,
    );
    return 0;
  }
  console.error(
    `staged changes are ${totalLines} line(s), above the ${FAIL_THRESHOLD}-line ` +
      `hard limit. Split the work into smaller commits; to bypass deliberately ` +
      `use git commit --no-verify.\n${detail}`,
  );
  process.exitCode = 1;
  return 1;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
