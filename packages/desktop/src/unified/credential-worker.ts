import {runCredentialWorker} from '@zhivex-ai/harness/application';
import {AsyncEntry} from '@napi-rs/keyring';
void runCredentialWorker(async account => {
  const entry = new AsyncEntry('ai.zhivex.assistant', account, {linux: {store: 'secret-service'}});
  return {read: () => entry.getPassword(), write: value => entry.setPassword(value)};
});
