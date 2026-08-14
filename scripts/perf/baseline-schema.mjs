const DISTRIBUTION_FIELDS = ['min', 'median', 'p95', 'max', 'samples'];
const METRIC_FIELDS = [
  'coldBuildMs',
  'warmQueryMs',
  'peakIncrementalMemoryBytes',
  'cancellationMs',
];

function present(value) {
  return value !== undefined && value !== null && value !== '';
}

function requireFields(errors, object, prefix, fields) {
  for (const field of fields) {
    if (!present(object?.[field])) errors.push(`missing ${prefix}.${field}`);
  }
}

export function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('percentile requires samples');
  if (!(fraction > 0 && fraction <= 1)) throw new Error('percentile fraction must be in (0, 1]');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

export function summarizeSamples(samples, warmupCount = 0) {
  if (!Number.isSafeInteger(warmupCount) || warmupCount < 0 || warmupCount >= samples.length) {
    throw new Error('warmupCount must leave at least one measured sample');
  }
  const measured = samples.slice(warmupCount);
  return {
    min: Math.min(...measured),
    median: percentile(measured, 0.5),
    p95: percentile(measured, 0.95),
    max: Math.max(...measured),
    samples: measured.length,
  };
}

export function validateBaseline(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['baseline must be an object'];
  requireFields(errors, value, 'baseline', ['schemaVersion', 'status']);
  requireFields(errors, value.environment, 'environment', ['os', 'arch']);
  requireFields(errors, value.app, 'app', ['name', 'version']);
  requireFields(errors, value.build, 'build', ['profile', 'gitCommit']);
  requireFields(errors, value.index, 'index', ['implementationId', 'schemaId']);
  requireFields(errors, value.corpus, 'corpus', [
    'fixtureVersion', 'fixtureDigest', 'seed', 'fileCount', 'digest', 'indexedMarkdownBytes', 'limits',
  ]);
  requireFields(errors, value.corpus?.limits, 'corpus.limits', [
    'maxFiles', 'maxFileBytes', 'maxAggregateBytes', 'maxResults',
    'maxQueryChars', 'maxSnippetChars',
  ]);
  requireFields(errors, value.measurement, 'measurement', [
    'wallClock', 'timingUnit', 'warmupCount', 'sampleCount', 'processCount', 'errorCount',
  ]);
  requireFields(errors, value.memory, 'memory', [
    'measurementKind', 'peakIncrementalBytesSamples', 'estimatedIndexBytes',
  ]);
  for (const metric of METRIC_FIELDS) {
    requireFields(errors, value.metrics?.[metric], `metrics.${metric}`, DISTRIBUTION_FIELDS);
    const distribution = value.metrics?.[metric];
    if (distribution && DISTRIBUTION_FIELDS.some((field) => (
      typeof distribution[field] !== 'number' || !Number.isFinite(distribution[field])
    ))) errors.push(`metrics.${metric} must contain finite numeric values`);
    if (distribution
      && !(distribution.min <= distribution.median
        && distribution.median <= distribution.p95
        && distribution.p95 <= distribution.max)) {
      errors.push(`metrics.${metric} distribution is not ordered`);
    }
  }
  if (!Array.isArray(value.errors)) errors.push('errors must be an array');
  else if (value.errors.length > 0) errors.push('baseline contains errors');
  if (value.schemaVersion !== 1) errors.push('unsupported baseline schemaVersion');
  if (value.measurement?.errorCount !== 0) errors.push('measurement.errorCount must be zero');
  for (const metric of ['coldBuildMs', 'warmQueryMs', 'cancellationMs']) {
    if (value.metrics?.[metric]?.samples !== value.measurement?.sampleCount) {
      errors.push(`metrics.${metric}.samples must equal measurement.sampleCount`);
    }
  }
  if (!Array.isArray(value.memory?.peakIncrementalBytesSamples)
    || value.memory.peakIncrementalBytesSamples.length !== value.measurement?.sampleCount
    || value.memory.peakIncrementalBytesSamples.some((sample) => (
      typeof sample !== 'number' || !Number.isFinite(sample) || sample < 0
    ))) {
    errors.push('memory.peakIncrementalBytesSamples must contain one finite sample per measurement sample');
  }
  if (value.metrics?.peakIncrementalMemoryBytes?.samples !== value.measurement?.sampleCount) {
    errors.push('metrics.peakIncrementalMemoryBytes.samples must equal measurement.sampleCount');
  }
  if (value.status !== 'complete') errors.push(`baseline is incomplete: ${value.incompleteReason ?? 'unknown reason'}`);
  else if (value.incompleteReason !== null) errors.push('complete baseline must have null incompleteReason');
  return errors;
}

function sameIdentity(left, right, fields) {
  return fields.every((field) => left?.[field] === right?.[field]);
}

export function compareBaselines(baseline, candidate, { rebaseline = null } = {}) {
  const baselineErrors = validateBaseline(baseline);
  const candidateErrors = validateBaseline(candidate);
  if (baselineErrors.length || candidateErrors.length) {
    throw new Error(`Cannot compare invalid baselines: ${[...baselineErrors, ...candidateErrors].join('; ')}`);
  }
  const environmentMatches = sameIdentity(baseline.environment, candidate.environment, ['os', 'arch']);
  const corpusMatches = sameIdentity(baseline.corpus, candidate.corpus, [
    'fixtureVersion', 'fixtureDigest', 'seed', 'fileCount', 'digest', 'indexedMarkdownBytes',
  ]) && JSON.stringify(baseline.corpus.limits) === JSON.stringify(candidate.corpus.limits);
  if ((!environmentMatches || !corpusMatches)
    && (!rebaseline?.reason || !rebaseline?.recordedAt)) {
    throw new Error('Environment or corpus changed; an explicit rebaseline record is required');
  }
  return {
    rebaseline,
    deltas: Object.fromEntries(METRIC_FIELDS.map((metric) => [
      metric,
      candidate.metrics[metric].p95 - baseline.metrics[metric].p95,
    ])),
  };
}

export function baselineGateMarkdown(baseline) {
  return `| ${baseline.corpus.fileCount.toLocaleString('en-US')} | ${baseline.corpus.indexedMarkdownBytes.toLocaleString('en-US')} | ${baseline.corpus.limits.maxFileBytes.toLocaleString('en-US')} | ${baseline.corpus.limits.maxAggregateBytes.toLocaleString('en-US')} | ${baseline.metrics.coldBuildMs.p95} | ${baseline.metrics.warmQueryMs.p95} | ${baseline.metrics.peakIncrementalMemoryBytes.p95} | ${baseline.metrics.cancellationMs.p95} |`;
}
