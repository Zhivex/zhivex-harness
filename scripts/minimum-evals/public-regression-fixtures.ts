/** Public CI inputs: only the two development examples, duplicated to exercise cohort contracts.
 * They are not the twelve private holdout tasks. No private holdout bytes belong here. */
import { mkdir, writeFile } from 'node:fs/promises';
import { digest, type MinimumFixture } from './protocol.js';

const development: MinimumFixture[] = [
  {
    "id": "dev-whitespace",
    "repository": "development",
    "split": "development",
    "mode": "repair",
    "files": {
      "src/space.js": "export const normalize=s=>s;\n"
    },
    "editable": [
      "src/space.js"
    ],
    "instructions": "Collapse whitespace runs to one space and trim ends. Change only src/space.js. Run the public test before and after editing; preserve package.json, tests and documentation.",
    "publicCheck": "import assert from 'node:assert/strict';\nimport {normalize} from './src/space.js'; assert.equal(normalize(' a  b '),'a b');\n",
    "oracle": "import assert from 'node:assert/strict';\nimport {normalize} from './src/space.js'; assert.equal(normalize(' a  b '),'a b');\n",
    "reference": {
      "src/space.js": "export const normalize=s=>s.trim().replace(/\\s+/g,' ');\n"
    },
    "constraints": [
      "exact-write-allowlist",
      "protected-checks",
      "no-network",
      "no-dependencies"
    ],
    "rubric": {
      "correctness": "All protected oracle assertions pass.",
      "scope": "Only the exact allowed implementation files change.",
      "review": "Human reviewer assesses readability and unnecessary complexity, blinded to variant."
    }
  },
  {
    "id": "dev-clamp",
    "repository": "development",
    "split": "development",
    "mode": "repair",
    "files": {
      "src/clamp.ts": "export const clamp=(n:number,min:number,max:number)=>n;\n"
    },
    "editable": [
      "src/clamp.ts"
    ],
    "instructions": "Clamp n inclusively between min and max. Change only src/clamp.ts. Run the public test before and after editing; preserve package.json, tests and documentation.",
    "publicCheck": "import assert from 'node:assert/strict';\nimport {clamp} from './src/clamp.ts'; assert.equal(clamp(4,0,2),2); assert.equal(clamp(-1,0,2),0);\n",
    "oracle": "import assert from 'node:assert/strict';\nimport {clamp} from './src/clamp.ts'; assert.equal(clamp(4,0,2),2); assert.equal(clamp(-1,0,2),0);\n",
    "reference": {
      "src/clamp.ts": "export const clamp=(n:number,min:number,max:number)=>Math.min(max,Math.max(min,n));\n"
    },
    "constraints": [
      "exact-write-allowlist",
      "protected-checks",
      "no-network",
      "no-dependencies"
    ],
    "rubric": {
      "correctness": "All protected oracle assertions pass.",
      "scope": "Only the exact allowed implementation files change.",
      "review": "Human reviewer assesses readability and unnecessary complexity, blinded to variant."
    }
  }
];

export async function writePublicRegressionCohort(directory: string) {
  const repositories = ['public-one', 'public-two', 'public-three'];
  const letters = 'abcdefghijkl';
  const generated = Array.from({ length: 12 }, (_, index) => ({ ...structuredClone(development[index % 2]!),
    id: index === 11 ? 'public-restart' : 'public-' + letters[index], repository: repositories[Math.floor(index / 4)]!, split: 'holdout' as const,
    mode: index === 11 ? 'restart' as const : 'repair' as const }));
  const tasks = [...generated, ...structuredClone(development)];
  const content = JSON.stringify({ schemaVersion: 1, revision: 'minimum-synthetic-js-ts-v1', provenance: 'Public generated regression cohort from two development examples; not private holdout or quality evidence.', repositories, tasks }, null, 2) + '\n';
  await mkdir(directory, { recursive: true });
  await writeFile(directory + '/cohort.json', content, { mode: 0o600 });
  await writeFile(directory + '/cohort.sha256', digest(content) + '\n', { mode: 0o600 });
  return directory;
}
