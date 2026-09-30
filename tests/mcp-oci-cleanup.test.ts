import { expect, test } from 'bun:test';
import { removeDockerMcpBoundary } from '../src/execution/mcp-oci-channel.js';

const id = 'a'.repeat(64);
test('failed graceful stop still removes the isolated boundary', async () => {
  let exists = true;
  await removeDockerMcpBoundary(async args => {
    if (args[0] === 'stop') throw new Error('runtime stop failure');
    if (args[0] === 'rm') exists = false;
    return args[0] === 'ps' && exists ? id : '';
  }, id);
  expect(exists).toBe(false);
});

test('failed removal cannot report cleanup when the container remains', async () => {
  await expect(removeDockerMcpBoundary(async args => {
    if (args[0] === 'rm') throw new Error('runtime remove failure');
    return args[0] === 'ps' ? id : '';
  }, id)).rejects.toThrow('removal was not confirmed');
});

test('unavailable runtime cannot establish absence', async () => {
  await expect(removeDockerMcpBoundary(async () => { throw new Error('runtime unavailable'); }, id))
    .rejects.toThrow('runtime unavailable');
});

test('a removal race succeeds only when absence is confirmed', async () => {
  let checked = false;
  await removeDockerMcpBoundary(async args => {
    if (args[0] !== 'ps') throw new Error('already removed');
    checked = true; return '';
  }, id);
  expect(checked).toBe(true);
});
