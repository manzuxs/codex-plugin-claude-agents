import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDotEnv } from '../plugins/claude-code-agents/server/lib/env.mjs';

test('parseDotEnv handles comments, export and quotes', () => {
  const parsed = parseDotEnv(`
# comment
export A=one
B="two words"
C='three # literal'
D=four # comment
`);
  assert.deepEqual(parsed, { A: 'one', B: 'two words', C: 'three # literal', D: 'four' });
});
