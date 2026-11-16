import {applicationRuntimeBinding} from '../runtime-binding.js';
import {projectCodeContext} from './context.js';
import { createCodeDelivery } from './delivery.js';
import { resolvePackageCheckCommand } from '../../execution/package-manager.js';
import { createHarness, type CreateHarnessOptions } from '../../runtime/harness.js';
import { recoverHarnessLocalService } from '../../client/local-service.js';
import { startApplicationHost } from '../host.js';

/** Shared Code composition for the service CLI and desktop-owned projects. */
export async function startCodeHost(options: { workspace: string; directory: string; recover?: boolean; engine?: Omit<CreateHarnessOptions, 'workspace'>; sensitiveValues?: readonly string[] }) {
  const harness = await createHarness({ ...options.engine, workspace: options.workspace });
  try {
    if (options.recover) try { await recoverHarnessLocalService(harness, options.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const service = await startApplicationHost(harness, { directory: options.directory, sensitiveValues: options.sensitiveValues ?? [] });
    const delivery = createCodeDelivery(service, harness.config.workspace, options.directory, options.sensitiveValues ?? []);
    let closing: Promise<void> | undefined;
    return {...service, binding: () => applicationRuntimeBinding(harness), context: () => projectCodeContext(harness, [...(options.sensitiveValues ?? []), ...Object.entries(process.env).filter(([key]) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(key)).map(([, value]) => value ?? '')]), delivery: delivery.call, close: () => closing ??= (async () => { try {await delivery.close();} finally {await service.close();} })(), async checks() {
      const file = await harness.workspace.readFile('package.json', 1, 2000);
      if (file.truncated) throw new Error('CHECK_MANIFEST_TOO_LARGE');
      const manifest = JSON.parse(file.content.split('\n').map(line => line.replace(/^\d+: /, '')).join('\n'));
      const checks: {name: string; script: string; argv: string[]}[] = [];
      for (const name of harness.config.allowedChecks) {
        const script = manifest.scripts?.[name]; if (typeof script !== 'string') continue;
        try { const resolved = await resolvePackageCheckCommand(harness.config.workspace, manifest, name, script, harness.config.allowedChecks); checks.push({name, script, argv: resolved.command}); } catch {}
      }
      return checks;
    }};
  } catch (error) { await harness.close(); throw error; }
}
