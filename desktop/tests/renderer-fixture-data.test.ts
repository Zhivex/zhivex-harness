import {expect, test} from "bun:test";
import type {BrowserWindow} from "electron";
import {fillRendererFixture, selectRendererFixture} from "../src/renderer-fixture-data.js";

test("fixture interactions pass hostile values as CDP arguments, never executable code", async () => {
 const calls: Array<{method: string; parameters: Record<string, unknown>}> = [];
 let attached = false;
 const window = {webContents: {debugger: {
  isAttached: () => attached, attach: () => {attached = true;}, detach: () => {attached = false;},
  sendCommand: async (method: string, parameters: Record<string, unknown>) => {
   calls.push({method, parameters});
   return method === "Runtime.evaluate" ? {result: {objectId: "fixture-global"}} : {result: {}};
  }
 }}} as unknown as BrowserWindow;
 const value = '\";globalThis.injected=true;// 🚀\u2028\n', selector = '[data-value="hostile\\\"selector"]';
 for (const operation of [fillRendererFixture, selectRendererFixture]) {
  await operation(window, selector, value);
  const call = calls.at(-1)!;
  expect(call.method).toBe("Runtime.callFunctionOn");
  expect(call.parameters.arguments).toEqual([{value: selector}, {value}]);
  expect(call.parameters.functionDeclaration).not.toContain(value);
  expect(call.parameters.functionDeclaration).not.toContain(selector);
  expect(attached).toBe(false);
 }
});
