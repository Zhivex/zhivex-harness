import {expect, test} from "bun:test";
import {runInNewContext} from "node:vm";
import {rendererFixtureData} from "../src/renderer-fixture-data.js";

test("renderer fixture data round-trips Unicode and hostile JavaScript without execution", () => {
 for (const value of ['";globalThis.injected=true;//', "</script><script>alert(1)</script>", "` ${globalThis.injected=true}", "á🚀\u2028\u2029\\\"\n"]) {
  const context = {atob, TextDecoder, Uint8Array, injected: false};
  expect(runInNewContext(rendererFixtureData(value), context)).toBe(value);
  expect(context.injected).toBe(false);
 }
});
