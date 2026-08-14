import fs from 'node:fs';
import process from 'node:process';
import { requiredMetricNames } from './professional-gate.mjs';

export function mergeProfessionalEvidence({ target, observations, requiredNames = requiredMetricNames() }) {
  const metrics = {};
  for (const observation of observations) {
    for (const [name, value] of Object.entries(observation)) {
      if (!requiredNames.includes(name)) throw new Error(`unknown metric: ${name}`);
      if (Object.hasOwn(metrics, name)) throw new Error(`duplicate metric: ${name}`);
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`metric must be finite and non-negative: ${name}`);
      metrics[name] = value;
    }
  }
  return {
    schemaVersion: 1,
    status: requiredNames.every((name) => Object.hasOwn(metrics, name)) ? 'complete' : 'incomplete',
    target,
    measuredAt: new Date().toISOString(),
    metrics,
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const [target, output, ...inputs] = process.argv.slice(2);
  if (!output || inputs.length === 0) throw new Error('usage: merge-professional-evidence <target> <output.json> <observations.json...>');
  const observations = inputs.map((input) => JSON.parse(fs.readFileSync(input, 'utf8')));
  fs.writeFileSync(output, `${JSON.stringify(mergeProfessionalEvidence({ target, observations }), null, 2)}\n`);
}
