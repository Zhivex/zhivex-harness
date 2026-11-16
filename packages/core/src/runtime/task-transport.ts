import type { LanguageModel } from '@zhivex-ai/core';

// Non-serializable host provenance survives the SDK's model wrappers. Workspace
// metadata cannot claim that an arbitrary injected adapter obeys dispatch limits.
const provenance = Symbol('harness-vetted-task-transport');
const capability = Object.freeze({ version: 1 });
export function markTaskTransportModel(model: LanguageModel): LanguageModel {
  Object.defineProperty(model, provenance, { value: capability, enumerable: true });
  return model;
}
export function isTaskTransportModel(model: LanguageModel): boolean {
  return Reflect.get(model, provenance) === capability;
}
