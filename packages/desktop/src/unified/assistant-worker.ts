import { acquireApplicationCoordinator, createProcessSecretStore } from '@zhivex-ai/harness/application';
import { connectCoordinator } from '@zhivex-ai/harness/application/client';
import { mkdir, realpath } from 'node:fs/promises';

const port = process.parentPort!;
let owner: Awaited<ReturnType<typeof acquireApplicationCoordinator>> | undefined;
let client: Awaited<ReturnType<typeof connectCoordinator>> | undefined;
let queue = Promise.resolve();
let acquire: (() => ReturnType<typeof acquireApplicationCoordinator>) | undefined;
port.on('message', ({data}: {data: {id: number; method: string; input?: any}}) => {
  const execute = async () => {
    try {
      let result: unknown;
      if (data.method === 'init') {
        if (client) throw new Error('ASSISTANT_ALREADY_STARTED');
        await mkdir(data.input.directory, {recursive: true, mode: 0o700});
        const directory = await realpath(data.input.directory);
        {
          const secrets = await createProcessSecretStore(directory, {executable: process.execPath, entry: data.input.credentialEntry, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}});
          acquire = () => acquireApplicationCoordinator(directory, {secrets});
          owner = await acquire();
          client = owner.client;
        }
        result = {...await client.state(), ownsService: owner.ownsService};
      } else if (data.method === 'reconnect') {
        if (!client || !owner || !acquire) throw new Error('ASSISTANT_NOT_STARTED');
        let recovered = false;
        try { await client.state(); }
        catch (error) {
          // Rediscover only on connection loss or stale credentials. Never replay a mutation.
          if (owner.ownsService || !(error instanceof Error) || !['LOCAL_SERVICE_UNAVAILABLE', 'LOCAL_SERVICE_HTTP_403'].includes(error.message)) throw error;
          owner = await acquire();
          client = owner.client; recovered = true;
        }
        result = {...await client.state(), ownsService: owner.ownsService, recovered};
      } else if (data.method === 'close') {
        await owner?.close(); owner = undefined; client = undefined;
      } else {
        if (!client) throw new Error('ASSISTANT_NOT_STARTED');
        const allowed = ['reply-watch-proposal', 'mail-draft-proposal', 'catalog', 'calendar-create-proposal', 'notes', 'agenda', 'authorization', 'automation', 'personal-state', 'state', 'shutdown-summary', 'action', 'code-configure', 'code-open', 'code-select', 'code-retry', 'code-tools', 'code-delivery'] as const;
        const method = allowed.find(value => value === data.method);
        if (!method) throw new Error('ASSISTANT_METHOD_INVALID');
        result = method === 'catalog' ? await client.catalog() : await client.call(method, data.input);
      }
      port.postMessage({id: data.id, result});
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,90}$/.test(error.message) ? error.message : 'ASSISTANT_RUNTIME_FAILED';
      port.postMessage({id: data.id, error: code});
    }
  };
  if (data.method === 'agenda') void execute(); else queue = queue.then(execute);
});
