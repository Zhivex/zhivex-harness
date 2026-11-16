import {expect, test} from 'bun:test';
import {projectCodeContext} from '../packages/core/src/application/code/context.js';

test('context projection excludes instruction bodies and unrelated configuration and redacts metadata', () => {
  const input = {
    config: {provider: 'openai', model: 'configured-secret', context: {enabled: true}, apiKey: 'never-export-this'},
    context: {fingerprint: 'sha256:bundle', sources: [{kind: 'rule', path: 'configured-secret.md', digest: 'sha256:source', bytes: 12, content: 'private rule body'}],
      skills: [{id: 'ghp_ExampleCredential', path: 'skills/test/SKILL.md', digest: 'sha256:skill', bytes: 20, description: 'private description'}]},
  } as unknown as Parameters<typeof projectCodeContext>[0];
  const snapshot = projectCodeContext(input, ['configured-secret']);
  expect(snapshot.model).toBe('[REDACTED]');
  expect(snapshot.sources[0]?.path).toBe('[REDACTED].md');
  expect(snapshot.skills[0]?.id).toBe('[REDACTED]');
  expect(JSON.stringify(snapshot)).not.toMatch(/private|never-export-this|configured-secret|ExampleCredential/);
  expect(snapshot.sources[0]?.digest).toBe('sha256:source');
  expect(snapshot.enabled).toBe(true);
});
