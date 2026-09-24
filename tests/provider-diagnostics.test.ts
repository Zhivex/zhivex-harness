import { expect, test } from "bun:test";
import { providerDiagnostic } from "../src/runtime/provider-diagnostics.js";
import { sanitizedErrorDetails } from "../src/runtime/error-diagnostics.js";
import { inspectProviderResponse } from "../scripts/time-to-safe-fix-model-observer.js";

for (const [body, status, reason, parameter] of [
  [{error:{type:"invalid_request_error",param:"previous_response_id",message:"Response SECRET expired"}},400,"previous_response_unavailable","previous_response_id"],
  [{error:{code:"context_length_exceeded",message:"SECRET"}},400,"context_length_exceeded","none"],
  [{error:{type:"authentication_error",message:"SECRET"}},401,"authentication","none"],
  [{error:{status:"RESOURCE_EXHAUSTED",message:"SECRET"}},429,"rate_limit","none"],
  [{error:{status:"INVALID_ARGUMENT",message:"SECRET",param:"tools"}},400,"invalid_request","tools"],
  [{error:{code:"model_not_found",message:"SECRET"}},404,"model_unavailable","none"],
  [{error:{param:"SECRET",message:"SECRET"}},503,"server_error","other"]
] as const) test(`provider-independent diagnosis: ${reason}/${parameter}`, async () => {
  const response = new Response(JSON.stringify(body), {status});
  const expected = {reason, parameter, bodyState:"parsed"} as const;
  expect(await inspectProviderResponse(response)).toEqual(expected);
  // Observing an error cannot consume the SDK's original response.
  expect(await response.json()).toEqual(body);
  const details = sanitizedErrorDetails(new Error("SECRET", {cause:{status,responseBody:JSON.stringify(body)}}));
  expect(details.chain.at(-1)?.provider).toEqual(expected);
  expect(JSON.stringify(details)).not.toContain("SECRET");
});

test("unknown and unsafe responses remain explicit and bounded", async () => {
  expect(providerDiagnostic("SECRET",400).bodyState).toBe("malformed");
  expect(providerDiagnostic("x".repeat(8193),400).bodyState).toBe("too_large");
  expect(await inspectProviderResponse(new Response("x".repeat(9000), {status:400}))).toMatchObject({bodyState:"too_large"});
  const stream = new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode("SECRET")); }});
  const response = new Response(stream, {status:400});
  const start = performance.now();
  expect(await inspectProviderResponse(response)).toMatchObject({bodyState:"read_timeout"});
  expect(performance.now() - start).toBeLessThan(1500);
  void response.body?.cancel();
  expect(sanitizedErrorDetails({status:400, provider:{reason:"SECRET"}}).chain[0]?.provider).toEqual(providerDiagnostic(undefined,400));
});
