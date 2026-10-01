import { expect, test } from 'bun:test';
import { acceptsVertexReleaseIdentity, vertexReleaseAttributeCondition, VERTEX_RELEASE_IDENTITY as identity } from '../scripts/vertex-release-identity.js';

const claims = (tag: string, workflow = 'release.yml') => ({
  repository_id: identity.repositoryId, repository_owner_id: identity.ownerId,
  sub: identity.subject, event_name: 'workflow_dispatch', ref: `refs/tags/${tag}`,
  workflow_ref: `${identity.repository}/.github/workflows/${workflow}@refs/tags/${tag}`
});

test('Vertex release identity admits future canonical tags without widening trust boundaries', () => {
  for (const tag of ['v1.3.0-rc.6', 'v1.3.0', 'v2.0.0-rc.1']) {
    for (const workflow of identity.workflows) expect(acceptsVertexReleaseIdentity(claims(tag, workflow))).toBe(true);
  }
  for (const patch of [
    { repository_id: 'another' }, { repository_owner_id: 'another' }, { sub: 'repo:Zhivex/zhivex-harness:pull_request' },
    { event_name: 'pull_request' }, { ref: 'refs/heads/main' },
    { workflow_ref: 'Zhivex/zhivex-harness/.github/workflows/other.yml@refs/tags/v1.3.0-rc.6' },
    { workflow_ref: 'Zhivex/zhivex-harness/.github/workflows/release.yml@refs/tags/v1.3.0-rc.5' }
  ]) expect(acceptsVertexReleaseIdentity({ ...claims('v1.3.0-rc.6'), ...patch })).toBe(false);
  for (const tag of ['v1.3.0-rc.0', 'v1.3.0-rc.06', 'v1.3.0-beta.1', 'v1.3.0/other', 'v1x3x0', 'v1.3.0\n']) {
    expect(acceptsVertexReleaseIdentity(claims(tag))).toBe(false);
  }
  const condition = vertexReleaseAttributeCondition();
  // CEL string decoding must leave the regex's literal dots intact.
  const pattern = condition.match(/matches\('([^']+)'\)/)![1]!;
  const generatedRegex = new RegExp(JSON.parse(`"${pattern}"`));
  expect(generatedRegex.test('refs/tags/v1.3.0-rc.6')).toBe(true);
  for (const ref of ['refs/heads/main', 'refs/tags/v1x3x0', 'refs/tags/v1.3.0-rc.0', 'refs/tags/v1.3.0-beta.1']) {
    expect(generatedRegex.test(ref)).toBe(false);
  }
  expect(condition).toContain("assertion.repository_id == '1336118843'");
  expect(condition).toContain("assertion.repository_owner_id == '84653499'");
  expect(condition).toContain("assertion.sub == '" + identity.subject + "'");
  expect(condition).toContain("assertion.event_name == 'workflow_dispatch'");
  for (const workflow of identity.workflows) expect(condition).toContain(`/.github/workflows/${workflow}@' + assertion.ref`);
});
