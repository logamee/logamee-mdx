import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const MiB = 1024 * 1024;

export const PROFESSIONAL_BUDGETS = Object.freeze({
  'startup.coldMs': 3000,
  'startup.warmMs': 1000,
  'startup.editableMs': 1500,
  'startup.firstPreviewMs': 2000,
  'markdown.1mb.loadMs': 1500,
  'markdown.1mb.editPreviewMs': 250,
  'markdown.5mb.loadMs': 5000,
  'markdown.5mb.previewMs': 6000,
  'markdown.contentHeavy.loadMs': 4000,
  'markdown.contentHeavy.previewMs': 5000,
  'excalidraw.100.loadMs': 1000,
  'excalidraw.100.editMs': 200,
  'excalidraw.100.saveMs': 500,
  'excalidraw.100.export3xMs': 3000,
  'excalidraw.500.loadMs': 2500,
  'excalidraw.500.editMs': 400,
  'excalidraw.500.saveMs': 1000,
  'excalidraw.500.export3xMs': 8000,
  'excalidraw.1000.loadMs': 5000,
  'excalidraw.1000.editMs': 750,
  'excalidraw.1000.saveMs': 2000,
  'excalidraw.1000.export3xMs': 15000,
  'memory.idleBytes': 300 * MiB,
  'memory.normalDocumentBytes': 450 * MiB,
  'memory.largeDocumentBytes': 900 * MiB,
  'memory.pdfPreviewBytes': 1100 * MiB,
  'memory.docxPreviewBytes': 900 * MiB,
  'size.appBytes': 350 * MiB,
  'size.installerBytes': 250 * MiB,
  'size.frontendBytes': 80 * MiB,
  'size.largestDependencyBytes': 60 * MiB,
});

const TARGETS = new Set(['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64']);

export function requiredMetricNames() {
  return Object.keys(PROFESSIONAL_BUDGETS);
}

export function evaluateProfessionalGate(evidence) {
  const errors = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return { status: 'fail', errors: ['evidence must be an object'], failedBudgets: [], checks: [] };
  if (evidence.schemaVersion !== 1) errors.push('unsupported schemaVersion');
  if (evidence.status !== 'complete') errors.push('evidence status must be complete');
  if (!TARGETS.has(evidence.target)) errors.push('unknown target');
  if (!Number.isFinite(Date.parse(evidence.measuredAt))) errors.push('invalid measuredAt');
  const metrics = evidence.metrics && typeof evidence.metrics === 'object' && !Array.isArray(evidence.metrics) ? evidence.metrics : {};
  const expectedNames = requiredMetricNames();
  for (const name of Object.keys(metrics)) if (!expectedNames.includes(name)) errors.push(`unexpected metric: ${name}`);
  const checks = expectedNames.map((name) => {
    const actual = metrics[name];
    if (actual === undefined || actual === null) errors.push(`missing metric: ${name}`);
    else if (typeof actual !== 'number' || !Number.isFinite(actual) || actual < 0) errors.push(`metric must be finite and non-negative: ${name}`);
    return { name, actual, budget: PROFESSIONAL_BUDGETS[name], passed: typeof actual === 'number' && Number.isFinite(actual) && actual >= 0 && actual <= PROFESSIONAL_BUDGETS[name] };
  });
  const failedBudgets = checks.filter((check) => !check.passed && typeof check.actual === 'number' && Number.isFinite(check.actual)).map((check) => check.name);
  return { schemaVersion: 1, status: errors.length === 0 && failedBudgets.length === 0 ? 'pass' : 'fail', target: evidence.target, errors, failedBudgets, checks };
}

function main() {
  const [input, output] = process.argv.slice(2);
  if (!input) throw new Error('usage: professional-gate <evidence.json> [report.json]');
  const report = evaluateProfessionalGate(JSON.parse(fs.readFileSync(input, 'utf8')));
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, errors: report.errors, failedBudgets: report.failedBudgets })}\n`);
  if (report.status !== 'pass') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) main();
