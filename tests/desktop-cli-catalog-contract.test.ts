import {expect, test} from 'bun:test';
import {consoleModelChoices} from '../packages/core/src/cli/console/console-navigation.js';
import {bundledModelCatalog} from '../packages/core/src/models/catalog.js';
import {providerDescriptor} from '../packages/core/src/runtime/config.js';

test('terminal choices preserve the engine catalog consumed by Desktop', () => {
  for (const provider of bundledModelCatalog.providers) {
    const choices = consoleModelChoices(provider.id, provider.defaultModel);
    expect(choices.map(m => m.value).sort()).toEqual(provider.models.map(m => m.id).sort());
  }
  const defaultModel = providerDescriptor('qwen').defaultModel;
  const choices = consoleModelChoices('qwen', defaultModel, 'qwen3.8-flash');
  expect(choices.find(m => m.value === 'qwen3.8-flash')?.detail).toContain('Current');
  expect(choices.find(m => m.value === defaultModel)?.detail).toContain('Recommended default');
});
