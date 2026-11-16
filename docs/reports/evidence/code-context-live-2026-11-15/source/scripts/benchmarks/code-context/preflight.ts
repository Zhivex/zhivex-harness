import assert from 'node:assert/strict';
import {fixture,tasks} from './fixtures.js';
import {executeTests} from './grade.js';
for(const task of tasks){const data=await fixture(task,6);const good=await executeTests(task,data.original),bad=await executeTests(task,data.buggy);assert(good.passed,JSON.stringify(good));assert(!bad.passed,'Injected defect must fail');console.log(JSON.stringify({task,context:data.context,good:good.passed,bugRejected:!bad.passed}));}
