import type {BrowserWindow} from "electron";

/** Test-driver-only interaction: CDP carries values separately from fixed code. */
async function callRenderer(window: BrowserWindow, functionDeclaration: string, values: string[]) {
 const debugger_ = window.webContents.debugger;
 const attachedHere = !debugger_.isAttached();
 if (attachedHere) debugger_.attach("1.3");
 try {
  const global = await debugger_.sendCommand("Runtime.evaluate", {expression: "globalThis"});
  if (global.exceptionDetails || !global.result?.objectId) throw new Error("FIXTURE_RENDERER_UNAVAILABLE");
  const response = await debugger_.sendCommand("Runtime.callFunctionOn", {
   objectId: global.result.objectId, functionDeclaration,
   arguments: values.map(value => ({value})), returnByValue: true, awaitPromise: true
  });
  if (response.exceptionDetails) throw new Error("FIXTURE_RENDERER_INTERACTION_FAILED");
 } finally {if (attachedHere) debugger_.detach();}
}

export function fillRendererFixture(window: BrowserWindow, selector: string, value: string) {
 return callRenderer(window, `function(selector, value) {
  const element = document.querySelector(selector);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
  element.dispatchEvent(new Event("input", {bubbles: true}));
 }`, [selector, value]);
}

export function selectRendererFixture(window: BrowserWindow, selector: string, value: string) {
 return callRenderer(window, `function(selector, value) {
  const element = document.querySelector(selector);
  element.value = value;
  element.dispatchEvent(new Event("change", {bubbles: true}));
 }`, [selector, value]);
}
