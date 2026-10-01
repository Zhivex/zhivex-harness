/** CEL policy for short-lived Vertex release identities. No credentials belong here. */
export const VERTEX_RELEASE_IDENTITY = {
  repository: 'Zhivex/zhivex-harness', repositoryId: '1336118843', ownerId: '84653499',
  subject: 'repo:Zhivex@84653499/zhivex-harness@1336118843:environment:live-certification',
  workflows: ['release.yml', 'live-certification.yml']
} as const;

export const vertexReleaseAttributeCondition = () => {
  const identity = VERTEX_RELEASE_IDENTITY;
  const workflow = identity.workflows.map(name =>
    `assertion.workflow_ref == '${identity.repository}/.github/workflows/${name}@' + assertion.ref`).join(' || ');
  return `assertion.repository_id == '${identity.repositoryId}' && assertion.repository_owner_id == '${identity.ownerId}' && ` +
    `assertion.sub == '${identity.subject}' && assertion.event_name == 'workflow_dispatch' && ` +
    `assertion.ref.matches('^refs/tags/v[0-9]+\\\\.[0-9]+\\\\.[0-9]+(-rc\\\\.[1-9][0-9]*)?$') && (${workflow})`;
};

/** Offline mirror used to test accepted/rejected claims before applying CEL. */
export const acceptsVertexReleaseIdentity = (claims: Record<string, string>) => {
  const identity = VERTEX_RELEASE_IDENTITY;
  return claims.repository_id === identity.repositoryId && claims.repository_owner_id === identity.ownerId &&
    claims.sub === identity.subject && claims.event_name === 'workflow_dispatch' &&
    /^refs\/tags\/v\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/.test(claims.ref ?? '') &&
    identity.workflows.some(name => claims.workflow_ref === `${identity.repository}/.github/workflows/${name}@${claims.ref}`);
};

if (import.meta.main) process.stdout.write(`${vertexReleaseAttributeCondition()}\n`);
