import { readFile, writeFile } from 'node:fs/promises';
import { planAssistantEvaluation, assistantEvaluationSuiteSchema } from '../src/evaluation.js';

const args = process.argv.slice(2);
const suite = assistantEvaluationSuiteSchema.parse(JSON.parse(await readFile(new URL('../evaluations/tasks.v1.json', import.meta.url), 'utf8')));
if (args.length === 1 && args[0] === '--validate') {
  console.log(JSON.stringify({ valid: true, cases: suite.cases.length, categories: [...new Set(suite.cases.map(c => c.category))] }));
} else if (args.length === 2 && args[0] === '--plan' && args[1]) {
  await writeFile(args[1], JSON.stringify(planAssistantEvaluation(suite), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'not-executed', trials: suite.cases.length * 3 }));
} else throw new Error('Usage: evaluate-tasks.ts --validate | --plan <new-private-report.json>');
