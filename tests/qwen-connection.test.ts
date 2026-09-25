import { test, expect } from "bun:test";
import { decodeQwenCredential, qwenEndpoint, selectQwenConnection } from "../src/cli/qwen-connection.js";

test("Qwen destinations are constrained to official regional hosts", () => {
  expect(qwenEndpoint({service:"api",region:"virginia",workspace:"llm-example"})).toBe("https://llm-example.us-east-1.maas.aliyuncs.com/compatible-mode/v1");
  expect(() => qwenEndpoint({service:"api",region:"frankfurt"})).toThrow("workspace");
  for (const workspace of ["evil.example", "../secret", "x@evil", "", "x/y"]) expect(() => qwenEndpoint({service:"api",region:"singapore",workspace})).toThrow();
  expect(() => decodeQwenCredential(JSON.stringify({version:1,key:"key",connection:{service:"api",region:"evil"}}))).toThrow();
  expect(decodeQwenCredential("legacy-key").connection).toEqual({service:"api",region:"singapore"});
});

test("workspace setup asks for a non-secret ID and cancellation exits", async () => {
  const choices: unknown[] = ["api", "frankfurt"];
  const connection = await selectQwenConnection({select:async()=>choices.shift() as never,secret:async()=>{throw new Error("must not ask for key");},question:async()=>"llm-demo"});
  expect(connection).toEqual({service:"api",region:"frankfurt",workspace:"llm-demo"});
});
