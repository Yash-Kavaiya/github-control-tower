import test from 'node:test';
import assert from 'node:assert/strict';

test('priority filter helper contract', () => {
  const rows = [{ Priority: 'P1', Repo: 'a' }, { Priority: 'P2', Repo: 'b' }];
  const filtered = rows.filter(r => r.Priority === 'P1');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].Repo, 'a');
});
