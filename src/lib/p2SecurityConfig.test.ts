import { describe, expect, it } from 'vitest';
import tauriConfig from '../../src-tauri/tauri.conf.json';
import cspBaselineFixture from '../../test-fixtures/p2/csp-baseline.json';

function tokenizeCsp(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const rawDirective of csp.split(';')) {
    const tokens = rawDirective.trim().split(/\s+/).filter(Boolean);
    const [name, ...sources] = tokens;
    if (name) directives.set(name, [...sources].sort());
  }
  return directives;
}

function sortedEntries(directives: Map<string, string[]>): Array<[string, string[]]> {
  return [...directives.entries()].sort(([left], [right]) => left.localeCompare(right));
}

describe('P2 packaged CSP compatibility contract', () => {
  it("preserves every baseline source token and adds only worker-src 'self'", () => {
    const baseline = tokenizeCsp(cspBaselineFixture.csp);
    const actual = tokenizeCsp(tauriConfig.app.security.csp);
    const addition = cspBaselineFixture.only_permitted_addition;
    const actualWithoutWorker = new Map(actual);
    actualWithoutWorker.delete(addition.directive);

    expect(sortedEntries(actualWithoutWorker)).toEqual(sortedEntries(baseline));
    expect(actual.get(addition.directive)).toEqual([...addition.sources].sort());

    const addedTokens = [...actual.entries()].flatMap(([directive, sources]) =>
      sources
        .filter((source) => !baseline.get(directive)?.includes(source))
        .map((source) => [directive, source] as const),
    );
    expect(addedTokens).toEqual([['worker-src', "'self'"]]);
    expect(addedTokens.flatMap(([, source]) => source)).not.toContain('blob:');
    expect(addedTokens.flatMap(([, source]) => source)).not.toContain("'unsafe-eval'");
  });

  it('keeps media, frame, and style source sets exactly unchanged', () => {
    const baseline = tokenizeCsp(cspBaselineFixture.csp);
    const actual = tokenizeCsp(tauriConfig.app.security.csp);

    for (const directive of cspBaselineFixture.sensitive_directives) {
      expect(actual.get(directive)).toEqual(baseline.get(directive));
    }
  });
});
