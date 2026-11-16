import { createApplicationReviewChannel } from "./review-channel.js";
import type { ZhivexHarness } from "../runtime/harness.js";
import { startHarnessLocalService, type HarnessLocalServiceOptions } from "../client/local-service.js";

/** The application owns lifecycle; the existing engine retains authoritative state,
 * admission, revisions and leases. Callers must close the harness if startup fails.
 */
export function startApplicationHost(harness: ZhivexHarness, options: HarnessLocalServiceOptions, review: Parameters<typeof createApplicationReviewChannel>[2] = {}) {
  return startHarnessLocalService(harness, { ...options, reviewChannel: (adapter, transportSecrets) => createApplicationReviewChannel(adapter, [
    ...transportSecrets, ...(options.sensitiveValues ?? []), ...Object.entries(process.env).filter(([key]) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(key)).map(([, value]) => value ?? ""),
  ], review) });
}
