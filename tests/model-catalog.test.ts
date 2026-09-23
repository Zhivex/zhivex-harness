import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { bundledModelCatalog, modelCatalogSchema, catalogModels } from "../src/models/catalog.js";
import { loadModelCatalog } from "../src/models/catalog-store.js";
import { consoleModelChoices, navigateConsole } from "../src/cli/console/console-navigation.js";
import { providerAvailability } from "../src/runtime/config.js";
import type { ConsoleInput } from "../src/cli/console/console-input.js";

const fixture = () => structuredClone(bundledModelCatalog);
test("new OpenAI choices default to GPT-6 Luna while explicit older choices remain selectable", () => {
  const provider = bundledModelCatalog.providers.find((entry) => entry.id === "openai")!;
  expect(provider.defaultModel).toBe("gpt-6-luna");
  expect(consoleModelChoices("openai", provider.defaultModel, "gpt-5.6-luna")[0]!.value).toBe("gpt-5.6-luna");
  expect(provider.models.find((entry) => entry.id === "gpt-6-luna")?.validation).toBe("unverified");
});
test("catalog rejects ambiguous identities, missing defaults and invalid replacements", () => {
  for (const mutate of [
    (c: ReturnType<typeof fixture>) => { c.providers[1] = c.providers[0]!; },
    (c: ReturnType<typeof fixture>) => { c.providers[0]!.models.push(c.providers[0]!.models[0]!); },
    (c: ReturnType<typeof fixture>) => { c.providers[0]!.defaultModel = "missing"; },
    (c: ReturnType<typeof fixture>) => { c.providers[0]!.models[0]!.replacement = "missing"; },
    (c: ReturnType<typeof fixture>) => { c.providers[0]!.models[0]!.name = "escape\u001b[31m"; },
  ]) { const c = fixture(); mutate(c); expect(modelCatalogSchema.safeParse(c).success).toBe(false); }
});

test("remote refresh, cache TTL, failed refresh, rollback and URL isolation", async () => {
  const cacheDirectory = await mkdtemp("/tmp/zhx-catalog-");
  const url = "https://catalog.example/models.json";
  const original = fixture(); original.revision = "older";
  const next = fixture(); next.revision = "newer";
  let response: unknown = next, calls = 0;
  const fetcher = (async () => { calls++; return Response.json(response); });
  try {
    expect((await loadModelCatalog({url,cacheDirectory,fetcher,now:100})).source).toBe("remote");
    expect((await loadModelCatalog({url,cacheDirectory,fetcher,now:200})).source).toBe("cache");
    expect(calls).toBe(1);
    response = {invalid:true};
    const failed = await loadModelCatalog({url,cacheDirectory,fetcher,now:300,refresh:true});
    expect(failed.catalog.revision).toBe("newer");expect(failed.stale).toBe(true);
    response = original;
    expect((await loadModelCatalog({url,cacheDirectory,fetcher,refresh:true})).catalog.revision).toBe("older");
    response = {invalid:true};
    expect((await loadModelCatalog({url:"https://other.example/models.json",cacheDirectory,fetcher})).source).toBe("bundled");
    const before = calls;
    expect((await loadModelCatalog({url:"http://catalog.example",cacheDirectory,fetcher})).source).toBe("bundled");
    expect(calls).toBe(before);
  } finally { await rm(cacheDirectory,{recursive:true,force:true}); }
});

test("oversized responses and network failure preserve the bundled catalog", async () => {
  const cacheDirectory = await mkdtemp("/tmp/zhx-catalog-");
  try {
    for (const fetcher of [
      async () => new Response("x".repeat(1024 * 1024 + 1)),
      async () => {throw new Error("offline");},
    ]) expect((await loadModelCatalog({url:"https://catalog.example",cacheDirectory,fetcher:fetcher})).source).toBe("bundled");
  } finally {await rm(cacheDirectory,{recursive:true,force:true});}
});

test("demotion and retirement preserve current IDs and show a replacement", () => {
  const c = fixture(); const provider = c.providers[0]!;
  const m = provider.models.find(m => m.id !== provider.defaultModel)!;
  m.group = "other";m.lifecycle = "retired";m.replacement = provider.defaultModel;
  const choices = consoleModelChoices(provider.id,provider.defaultModel,m.id,c);
  expect(choices[0]!.value).toBe(m.id);
  expect(choices[0]!.detail).toContain("Retired");
  expect(choices[0]!.detail).toContain(provider.defaultModel);
  expect(catalogModels(c,provider.id,"custom-current")[0]!.id).toBe("custom-current");
});

test("CLI exposes Other models as a separate page and selects an explicit choice", async () => {
  const pages: string[] = [];
  const answers = [{kind:"other",id:""},{kind:"model",id:"gpt-5.5"}];
  const input = {select:async (title: string) => {pages.push(title);return answers.shift();},question:async()=>""} as unknown as Pick<ConsoleInput,"select"|"question">;
  const result = await navigateConsole(input,{entry:"model",providers:providerAvailability({}),current:{provider:"openai",model:"gpt-5.6-luna"},sessions:async()=>[]});
  expect(result).toEqual({provider:"openai",model:"gpt-5.5"});
  expect(pages[1]).toContain("Other models");
});
