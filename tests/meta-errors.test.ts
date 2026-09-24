import {expect, test} from "bun:test";
import {ProviderHTTPError} from "@zhivex-ai/core/provider";
import {annotateMetaRequestError} from "../src/providers/meta-errors.js";

for (const [detail, reason] of [
  [{code:"context_length_exceeded"}, "context length exceeded"],
  [{param:"tools"}, "tools rejected"],
  [{param:"input"}, "input rejected"],
  [{param:"max_output_tokens"}, "output token limit rejected"],
  [{param:"previous_response_id"}, "previous response rejected"],
  [{type:"invalid_request_error",param:"model",message:"Response not found SECRET"}, "reason unavailable"],
  [{message:"SECRET",param:"SECRET"}, "reason unavailable"],
] as const) test(`Meta diagnostic projects only a fixed reason: ${reason}`, () => {
  const error = new ProviderHTTPError("generic",400,{responseBody:JSON.stringify({error:detail})});
  try {annotateMetaRequestError(error);} catch (caught) {
    expect(caught).toBe(error);
    expect(error.message).toBe(`Meta request failed with status 400 (${reason}).`);
    expect(error.message).not.toContain("SECRET");
  }
});

test("malformed provider bodies and non-HTTP errors remain safe", () => {
  const error = new ProviderHTTPError("generic",400,{responseBody:"SECRET invalid JSON"});
  expect(() => annotateMetaRequestError(error)).toThrow("Meta request failed with status 400 (reason unavailable).");
  const unrelated = new Error("unrelated");
  try {annotateMetaRequestError(unrelated);} catch (caught) {expect(caught).toBe(unrelated);}
  expect(unrelated.message).toBe("unrelated");
});
