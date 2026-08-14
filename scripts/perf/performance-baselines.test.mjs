import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { baselineGateMarkdown, validateBaseline } from './baseline-schema.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

for (const corpus of ['10k', '100k']) {
  test(`${corpus} 已提交产物完整且文档逐值一致`, async () => {
    const [artifactText, documentation] = await Promise.all([
      readFile(path.join(projectRoot, 'scripts', 'perf', 'baselines', `${corpus}.json`), 'utf8'),
      readFile(path.join(projectRoot, 'docs', 'performance-baselines.md'), 'utf8'),
    ]);
    const artifact = JSON.parse(artifactText);

    assert.deepEqual(validateBaseline(artifact), []);
    assert.match(documentation, new RegExp(`^${baselineGateMarkdown(artifact)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  });
}

test('文档准确说明 FTS5 ADR 触发条件和内存测量定义', async () => {
  const documentation = await readFile(
    path.join(projectRoot, 'docs', 'performance-baselines.md'),
    'utf8',
  );
  assert.match(documentation, /增量内存峰值.*最大驻留集大小.*减去.*构建前/si);
  assert.match(documentation, /100,000.*构建.*查询.*内存.*取消.*FTS5 ADR/si);
  assert.match(documentation, /工程验收门槛.*不是.*产品.*承诺/si);
});

test('文档说明非破坏性 M3 门禁命令和结果语义', async () => {
  const documentation = await readFile(
    path.join(projectRoot, 'docs', 'performance-baselines.md'),
    'utf8',
  );

  assert.match(documentation, /npm run perf:gate/);
  assert.match(documentation, /绝不会覆盖.*scripts\/perf\/baselines/si);
  assert.match(documentation, /`pass`.*`fail`.*`not-comparable`/si);
  assert.match(documentation, /完整.*可比较.*p95.*退出码.*0/si);
});
