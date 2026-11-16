import { AsyncLocalStorage } from 'node:async_hooks';

/** Internal, non-serializable admission context. Only the task owner supplies it. */
export interface TaskUsageAdmission {
  accountRunId: string;
  operationId: string;
  category: 'execution' | 'compaction' | 'closure';
  closureReserve: number;
  inputCeiling: number;
  monetaryRefused: boolean;
  /** Final synchronous gate after intervening asynchronous host middleware. */
  assertActive(): void;
}
export const taskUsageAdmission = new AsyncLocalStorage<TaskUsageAdmission>();
