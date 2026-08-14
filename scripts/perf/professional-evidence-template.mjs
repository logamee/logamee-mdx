import fs from 'node:fs';
import process from 'node:process';
import { requiredMetricNames } from './professional-gate.mjs';

export function createProfessionalEvidenceTemplate(target) {
  return {
    schemaVersion: 1,
    status: 'incomplete',
    target,
    measuredAt: new Date().toISOString(),
    metrics: Object.fromEntries(requiredMetricNames().map((name) => [name, null])),
  };
}

function main() {
  const [target, output] = process.argv.slice(2);
  if (!target || !output) throw new Error('usage: professional-evidence-template <target> <output.json>');
  fs.writeFileSync(output, `${JSON.stringify(createProfessionalEvidenceTemplate(target), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) main();
