import type { HarnessProvider } from '../src/runtime/config.js';

/** Keep the historical default cohort; new routes require explicit selection. */
export function selectContinuityProviders(env:NodeJS.ProcessEnv,available:readonly HarnessProvider[]):HarnessProvider[] {
  const configured=env.ZHIVEX_HARNESS_LIVE_PROVIDERS;
  const selected=configured===undefined?['openai','qwen','meta']:[...new Set(configured.split(',').map(value=>value.trim().toLowerCase()).filter(Boolean))];
  if(!selected.length || selected.some(provider=>!available.includes(provider as HarnessProvider)))throw new Error('Continuity provider selection is empty or unavailable in the selected artifact.');
  return selected as HarnessProvider[];
}
