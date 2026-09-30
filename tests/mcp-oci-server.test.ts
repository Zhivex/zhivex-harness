import { expect, test } from 'bun:test';
import { attestMcpServer, effectiveMcpContainerEnvironment } from '../src/execution/mcp-oci-server.js';
import type { McpStdioLaunchProposal } from '../src/integrations/mcp-stdio-admission.js';
const imageId = `sha256:${'a'.repeat(64)}`;
const proposal: McpStdioLaunchProposal = { schemaVersion: 1, serverId: 'local', boundary: 'oci', image: `local/server@${imageId}`,
  executable: '/usr/bin/server', args: ['--stdio'], protocolVersion: '2025-11-25', workingDirectory: '.', snapshotDigest: imageId,
  scope: { principal: 'p', tenant: 't', session: 's', workspace: imageId }, includeTools: ['lookup'], permissions: ['read'], environment: {}, secretReferences: {},
  limits: { sessionMs: 1000, callMs: 500, memoryMb: 128, maxCpus: 0.5, maxPids: 16, maxWorkspaceBytes: 1048576, maxFileWriteBytes: 4096, tmpfsMb: 1, maxOutputBytes: 4096 } };
const expected = { imageId, volumeName: 'private', proposal, environment: { HOME: '/tmp', ZHIVEX_MCP_TOKEN: 'canary' } };
function inspection() { return {
  Image: imageId, State: { Status: 'created' },
  Config: { Entrypoint: ['/usr/bin/server'], Cmd: ['--stdio'], User: '65532:65532', Hostname: 'mcp', WorkingDir: '/workspace', Healthcheck: { Test: ['NONE'] }, Env: ['HOME=/tmp', 'ZHIVEX_MCP_TOKEN=canary', 'PATH'] },
  HostConfig: { RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'none' }, IpcMode: 'none', Memory: 128 * 1024 * 1024, MemorySwap: 128 * 1024 * 1024,
    PidsLimit: 16, NanoCpus: 500000000, Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=1m,uid=65532,gid=65532,mode=0700' }, Ulimits: [{ Name: 'fsize', Hard: 4096, Soft: 4096 }] },
  Mounts: [{ Type: 'volume', Name: 'private', Destination: '/workspace', RW: false }]
}; }
test('exact immutable server plan passes before start', () => { expect(() => attestMcpServer(inspection(), expected)).not.toThrow(); });
const changes: Record<string, (v: ReturnType<typeof inspection>) => void> = {
  image: v => { v.Image = 'other'; }, started: v => { v.State.Status = 'running'; },
  executable: v => { v.Config.Entrypoint = ['/bin/sh']; }, args: v => { v.Config.Cmd.push('--extra'); },
  user: v => { v.Config.User = '0:0'; }, cwd: v => { v.Config.WorkingDir = '/'; },
  healthcheck: v => { v.Config.Healthcheck.Test = ['CMD', 'other']; }, restart: v => { v.HostConfig.RestartPolicy.Name = 'always'; },
  logs: v => { v.HostConfig.LogConfig.Type = 'json-file'; }, ipc: v => { v.HostConfig.IpcMode = 'host'; },
  memory: v => { v.HostConfig.Memory *= 2; }, swap: v => { v.HostConfig.MemorySwap = -1; },
  cpu: v => { v.HostConfig.NanoCpus *= 2; }, pids: v => { v.HostConfig.PidsLimit = -1; },
  tmpfs: v => { v.HostConfig.Tmpfs['/tmp'] = 'rw,size=1g'; }, writes: v => { v.HostConfig.Ulimits[0]!.Hard *= 2; },
  environment: v => { v.Config.Env.push('NODE_OPTIONS=--require=canary'); }, secret: v => { v.Config.Env[1] = 'ZHIVEX_MCP_TOKEN=changed'; },
  volume: v => { v.Mounts[0]!.Name = 'foreign'; }, writePermission: v => { v.Mounts[0]!.RW = true; }
};
for (const [name, change] of Object.entries(changes)) {
  test(`attestation rejects ${name} drift`, () => {
    const value = inspection(); change(value);
    expect(() => attestMcpServer(value, expected)).toThrow('does not match');
  });
}
test('environment parsing rejects duplicates and malformed names without values in errors', () => {
  expect(effectiveMcpContainerEnvironment(['PATH', 'HOME=/tmp', 'TOKEN=a=b'])).toEqual({ HOME: '/tmp', TOKEN: 'a=b' });
  for (const input of [['TOKEN=canary', 'TOKEN'], ['bad-name=canary'], [null], null]) {
    expect(() => effectiveMcpContainerEnvironment(input)).toThrow('Invalid MCP container environment.');
  }
});
