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
  it("preserves every baseline source token and adds only approved compatibility sources", () => {
    const baseline = tokenizeCsp(cspBaselineFixture.csp);
    const actual = tokenizeCsp(tauriConfig.app.security.csp);
    const additions = [
      ['media-src', 'http://127.0.0.1:*'],
      ['connect-src', 'http://127.0.0.1:*'],
      [cspBaselineFixture.only_permitted_addition.directive, cspBaselineFixture.only_permitted_addition.sources[0]],
    ] as const;
    const actualWithoutWorker = new Map(actual);
    for (const [directive, source] of additions) {
      if (directive === cspBaselineFixture.only_permitted_addition.directive) {
        actualWithoutWorker.delete(directive);
      } else {
        actualWithoutWorker.set(directive, actualWithoutWorker.get(directive)?.filter((value) => value !== source) ?? []);
      }
    }

    expect(sortedEntries(actualWithoutWorker)).toEqual(sortedEntries(baseline));
    expect(actual.get(cspBaselineFixture.only_permitted_addition.directive)).toEqual([...cspBaselineFixture.only_permitted_addition.sources].sort());

    const addedTokens = [...actual.entries()].flatMap(([directive, sources]) =>
      sources
        .filter((source) => !baseline.get(directive)?.includes(source))
        .map((source) => [directive, source] as const),
    );
    expect(addedTokens).toEqual(additions.map(([directive, source]) => [directive, source]));
    expect(addedTokens.flatMap(([, source]) => source)).not.toContain('blob:');
    expect(addedTokens.flatMap(([, source]) => source)).not.toContain("'unsafe-eval'");
  });

  it('keeps media, frame, and style source sets exactly unchanged', () => {
    const baseline = tokenizeCsp(cspBaselineFixture.csp);
    const actual = tokenizeCsp(tauriConfig.app.security.csp);

    for (const directive of cspBaselineFixture.sensitive_directives) {
      const expected = directive === 'media-src'
        ? [...(baseline.get(directive) ?? []), 'http://127.0.0.1:*'].sort()
        : baseline.get(directive);
      expect(actual.get(directive)).toEqual(expected);
    }
  });

  it('allows the MPEG-TS loader to fetch authorized loopback media', () => {
    const actual = tokenizeCsp(tauriConfig.app.security.csp);

    expect(actual.get('connect-src')).toContain('http://127.0.0.1:*');
  });
});
