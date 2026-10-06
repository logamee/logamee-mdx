// Local CI entry point: runs the documented validation sequence from
// docs/testing/validation-matrix.md as one fail-fast command, plus the
// platform API audit that guards against cross-platform compile breakage
// (platform-specific Rust APIs outside cfg gates) and the code-quality
// ratchets (code size/complexity baseline, duplication ceiling, and the
// unit tests of these gate scripts themselves).
//
// This is a developer convenience gate for pre-push validation; it does not
// replace the remote four-platform GitHub Actions runs recorded in the
// validation matrix.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function buildDefaultSteps() {
  return [
    { name: 'git diff --check', command: 'git', args: ['diff', '--check'] },
    {
      name: 'platform API audit',
      command: 'node',
      args: ['scripts/ci/check-platform-apis.mjs'],
    },
    { name: 'frontend typecheck', command: 'npm', args: ['run', 'typecheck'] },
    { name: 'frontend lint', command: 'npm', args: ['run', 'lint'] },
    { name: 'code-size ratchet', command: 'node', args: ['scripts/ci/check-code-size.mjs'] },
    {
      name: 'code-quality unit tests',
      command: 'node',
      args: [
        '--test',
        'scripts/ci/check-code-size.node-test.mjs',
        'scripts/ci/hotspots.node-test.mjs',
        'scripts/ci/check-commit-size.node-test.mjs',
      ],
    },
    { name: 'duplication ratchet', command: 'npm', args: ['run', 'check:duplication'] },
    { name: 'dead-code', command: 'npm', args: ['run', 'check:dead-code'] },
    { name: 'circular deps', command: 'npm', args: ['run', 'check:circular'] },
    { name: 'frontend unit tests', command: 'npm', args: ['test'] },
    { name: 'frontend production build', command: 'npm', args: ['run', 'build'] },
    {
      name: 'rust check',
      command: 'cargo',
      args: ['check', '--manifest-path', 'src-tauri/Cargo.toml'],
    },
    { name: 'rust quality clippy', command: 'npm', args: ['run', 'lint:rust-quality'] },
    {
      name: 'rust unit tests',
      command: 'cargo',
      args: ['test', '--manifest-path', 'src-tauri/Cargo.toml'],
    },
  ];
}

function spawnStep(step) {
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, output: code === 0 ? '' : `exit code ${code}` });
    });
    child.on('error', (error) => {
      resolve({ ok: false, output: error.message });
    });
  });
}

export async function runLocalCi({ steps, exec = spawnStep }) {
  const results = [];
  let failedStep = null;

  for (const step of steps) {
    if (failedStep !== null) {
      results.push({ name: step.name, ok: null });
      continue;
    }
    console.log(`▶ ${step.name}`);
    const startedAt = Date.now();
    const outcome = await (step.exec ?? exec)(step);
    const durationMs = Date.now() - startedAt;
    results.push({ name: step.name, ok: outcome.ok, durationMs });
    if (!outcome.ok) {
      failedStep = step.name;
      console.error(`✗ ${step.name} failed (${outcome.output})`);
    } else {
      console.log(`✓ ${step.name} (${durationMs} ms)`);
    }
  }

  return { ok: failedStep === null, failedStep, steps: results };
}

function isMainProcess() {
  return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
}

if (isMainProcess()) {
  console.log(`local CI: running ${buildDefaultSteps().length} gates in ${repoRoot}`);
  const outcome = await runLocalCi({ steps: buildDefaultSteps() });

  console.log('\nsummary:');
  for (const step of outcome.steps) {
    const status = step.ok === null ? 'skipped' : step.ok ? 'pass' : 'FAIL';
    console.log(`  ${status.padEnd(8)} ${step.name}`);
  }

  process.exit(outcome.ok ? 0 : 1);
}
