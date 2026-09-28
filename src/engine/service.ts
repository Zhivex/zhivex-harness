/** Explicit Harness integration surface. See contracts/engine-api.json for stability tiers. */
export { harnessLocalCredentialsSchema, startHarnessLocalService, readHarnessLocalCredentials, requestHarnessLocalService, recoverHarnessLocalService } from "../client/local-service.js";
export type { HarnessLocalService, HarnessLocalServiceOptions, HarnessLocalCredentials } from "../client/local-service.js";
export { openHarnessActivityStore } from "../client/service-events.js";
export type { HarnessActivityEvent, HarnessActivityRun, HarnessActivitySnapshot, HarnessActivityPage, HarnessActivityStore, HarnessActivityOptions } from "../client/service-events.js";
