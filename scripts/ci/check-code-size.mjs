// Ratchet gate for the quantified code-size contracts in AGENTS.md:
//   - single function <= 80 lines       (oxlint max-lines-per-function)
//   - single source file <= 500 lines   (oxlint max-lines, Rust line count)
//   - cyclomatic complexity <= 10       (oxlint complexity)
//
// Legacy violations are pinned in scripts/ci/baselines/code-size.json. The
// gate fails only on violations missing from the baseline, so the pinned set
// can only shrink. Regenerate with --update-baseline after a cleanup removes
// violations, or when an approved refactor relocates pinned ones, and commit
// the shrunk baseline in the same change.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');

export const QUALITY_RULE_CODES = new Set([
  'eslint(max-lines)',
  'eslint(max-lines-per-function)',
  'eslint(complexity)',
]);

export const RUST_FILE_MAX_LINES = 500;

export function baselinePathFor(root) {
  return path.join(root, 'scripts', 'ci', 'baselines', 'code-size.json');
}

export function defaultQualityConfigPath() {
  return path.join(repoRoot, '.oxlintrc.code-quality.json');
}

// oxlint anchors ignorePatterns at the config directory, so the quality
// config lives at the repository root; the parser still skips test files
// defensively in case that anchoring changes between oxlint releases.
const TEST_FILE_PATTERN = /\.test\.(?:[cm]?[jt]sx?)$/;

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function resolveOxlintBin() {
  const bin = process.platform === 'win32' ? 'oxlint.cmd' : 'oxlint';
  return path.join(repoRoot, 'node_modules', '.bin', bin);
}

export function parseOxlintJson(stdout, root) {
  const parsed = JSON.parse(stdout);
  const violations = new Map();
  for (const diagnostic of parsed.diagnostics ?? []) {
    if (!QUALITY_RULE_CODES.has(diagnostic.code)) continue;
    // oxlint echoes the target path as given: absolute for absolute targets,
    // relative to its cwd otherwise. Resolve against root for stable keys.
    const absolute = path.resolve(root, diagnostic.filename);
    const relative = toPosix(path.relative(root, absolute));
    if (relative.startsWith('..') || TEST_FILE_PATTERN.test(relative)) continue;
    const line = diagnostic.labels?.[0]?.span?.line ?? 0;
    const rule = diagnostic.code.replace(/^eslint\(/, '').replace(/\)$/, '');
    // Keys keep the function name from the message but strip numbers, so
    // pinned violations survive line shifts while genuinely new violating
    // functions still fail the ratchet.
    const normalized = diagnostic.message.replace(/\d+/g, '');
    violations.set(
      `${diagnostic.code}|${relative}|${normalized}`,
      `${relative}:${line} ${rule} — ${diagnostic.message}`,
    );
  }
  return violations;
}

export function findRustFileViolations(root) {
  const violations = new Map();
  const rustRoot = path.join(root, 'src-tauri', 'src');
  if (!fs.existsSync(rustRoot)) return violations;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.rs')) continue;
      const lineCount = fs.readFileSync(full, 'utf8').split('\n').length;
      if (lineCount <= RUST_FILE_MAX_LINES) continue;
      const relative = toPosix(path.relative(root, full));
      violations.set(
        `rs-max-lines|${relative}`,
        `${relative}:1 rs-max-lines — file has ${lineCount} lines (max ${RUST_FILE_MAX_LINES})`,
      );
    }
  };
  walk(rustRoot);
  return violations;
}

export function loadBaseline(root) {
  const file = baselinePathFor(root);
  if (!fs.existsSync(file)) return { version: 1, keys: [] };
  const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (baseline.version !== 1 || !Array.isArray(baseline.keys)) {
    throw new Error(`unexpected baseline format in ${file}`);
  }
  return baseline;
}

export function writeBaseline(root, keys) {
  const file = baselinePathFor(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = { version: 1, keys: [...keys].sort() };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}

export async function collectCurrentViolations({
  root,
  configPath = defaultQualityConfigPath(),
  exec = execFileAsync,
}) {
  let stdout;
  try {
    const result = await exec(resolveOxlintBin(), [
      '-c',
      configPath,
      '--format',
      'json',
      'src',
    ], { cwd: root, shell: process.platform === 'win32' });
    stdout = result.stdout;
  } catch (error) {
    // oxlint exits non-zero when it reports errors; the JSON is on stdout.
    if (!error.stdout) throw error;
    stdout = error.stdout;
  }
  return parseOxlintJson(stdout, root);
}

export async function runCheck({ root, updateBaseline = false, exec = execFileAsync }) {
  const current = new Map([
    ...(await collectCurrentViolations({ root, exec })),
    ...findRustFileViolations(root),
  ]);
  const baselineKeys = new Set(loadBaseline(root).keys);
  const newKeys = [...current.keys()]
    .filter((key) => !baselineKeys.has(key))
    .sort();
  const removedKeys = [...baselineKeys]
    .filter((key) => !current.has(key))
    .sort();
  if (updateBaseline) {
    writeBaseline(root, current.keys());
    return { ok: true, updated: true, newKeys: [], removedKeys, total: current.size };
  }
  return { ok: newKeys.length === 0, updated: false, newKeys, removedKeys, total: current.size };
}

function printReport(violations) {
  const rows = [...violations.values()].sort();
  for (const row of rows) console.log(`  ${row}`);
  return rows.length;
}

async function main() {
  const args = process.argv.slice(2);
  const root = args.includes('--root')
    ? path.resolve(args[args.indexOf('--root') + 1])
    : repoRoot;
  const result = await runCheck({
    root,
    updateBaseline: args.includes('--update-baseline'),
  });
  if (result.updated) {
    console.log(`baseline updated: pinned ${result.total} violation(s)`);
    return 0;
  }
  if (args.includes('--report')) {
    const current = new Map([
      ...(await collectCurrentViolations({ root })),
      ...findRustFileViolations(root),
    ]);
    console.log(`current violations: ${printReport(current)}`);
  }
  console.log(`pinned legacy violations: ${result.total - result.newKeys.length}`);
  if (result.removedKeys.length > 0) {
    console.log(`fixed since baseline: ${result.removedKeys.length} (run with --update-baseline to shrink it)`);
  }
  if (result.newKeys.length > 0) {
    console.error(`new code-size violations: ${result.newKeys.length}`);
    for (const key of result.newKeys) console.error(`  ${key}`);
    process.exitCode = 1;
  } else {
    console.log('code-size ratchet: ok');
  }
  return process.exitCode ?? 0;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
