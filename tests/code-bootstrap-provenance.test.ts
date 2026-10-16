import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const { assertDsseEntryMatchesProposed, bindEquivalentTLogReuse, equivalentEntryId } = require("../scripts/code-bootstrap-provenance.cjs") as {
  assertDsseEntryMatchesProposed: (existing: { body: string }, proposed: Proposed) => void,
  bindEquivalentTLogReuse: (client: { prototype: { createEntry: (proposed: Proposed) => Promise<unknown> } }) => void,
  equivalentEntryId: (error: unknown) => string | undefined,
};

const entryId = "108e9186e8c5677a7c0c8e287d595b7e7713efd4cb6186c84890ee93437aa1180f271094cc6d535c";
const certificate = Buffer.from("code-provenance-certificate");
const signature = "MEUCIHuaTuTDxqSlBNxsWIP7bR8gWflR1example";

interface Proposed {
  apiVersion: string;
  kind: string;
  spec: { proposedContent: { envelope: string, verifiers: string[] } };
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}
function pem(der: Buffer) {
  return `-----BEGIN CERTIFICATE-----\n${der.toString("base64")}\n-----END CERTIFICATE-----\n`;
}
function proposal(payload = "{\"subject\":true}", sig = signature, der = certificate): Proposed {
  const envelope = { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(payload).toString("base64"), signatures: [{ sig }] };
  return { apiVersion: "0.0.1", kind: "dsse", spec: { proposedContent: { envelope: JSON.stringify(envelope), verifiers: [der.toString("base64")] } } };
}
function logged(proposed: Proposed, der = certificate) {
  const envelopeJSON = proposed.spec.proposedContent.envelope;
  const envelope = JSON.parse(envelopeJSON) as { payload: string, signatures: [{ sig: string }] };
  const body = {
    apiVersion: "0.0.1", kind: "dsse",
    spec: {
      envelopeHash: { algorithm: "sha256", value: sha256(envelopeJSON) },
      payloadHash: { algorithm: "sha256", value: sha256(Buffer.from(envelope.payload, "base64")) },
      signatures: [{ signature: envelope.signatures[0].sig, verifier: Buffer.from(pem(der)).toString("base64") }],
    },
  };
  return { body: Buffer.from(JSON.stringify(body)).toString("base64") };
}
function conflict(id = entryId, location: string | null = `https://rekor.sigstore.dev/api/v1/log/entries/${id}`) {
  const cause = Object.assign(new Error(`(409) an equivalent entry already exists in the transparency log with UUID ${id}`), {
    statusCode: 409, ...(location === null ? {} : { location }),
  });
  return Object.assign(new Error(`error creating tlog entry - ${cause.message}`), { cause });
}

test("conflict parser accepts the failed release error and requires one entry id", () => {
  const failed = "error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID 108e9186e8c5677a7c0c8e287d595b7e7713efd4cb6186c84890ee93437aa1180f271094cc6d535c";
  expect(equivalentEntryId(new Error(failed))).toBe(entryId);
  expect(equivalentEntryId(conflict())).toBe(entryId);
  expect(equivalentEntryId(conflict(entryId, null))).toBe(entryId);
  expect(equivalentEntryId(Object.assign(new Error("(409) conflict"), { statusCode: 409 }))).toBeUndefined();
  expect(equivalentEntryId(Object.assign(new Error(failed), { statusCode: 500 }))).toBeUndefined();
  expect(() => equivalentEntryId(conflict(entryId, "https://rekor.sigstore.dev/api/v1/log/entries/" + "ab".repeat(32)))).toThrow("two different entries");
});

test("equivalent Rekor entries are reused only when they bind this signature", async () => {
  const proposed = proposal();
  const existing = logged(proposed);
  assertDsseEntryMatchesProposed(existing, proposed);
  const fetched: string[] = [];
  let conflicted = true;
  class TLogClient {
    rekor = { getEntry: async (id: string) => { fetched.push(id); return existing; } };
    async createEntry(_proposed: Proposed): Promise<unknown> {
      if (conflicted) throw conflict();
      return "created";
    }
  }
  bindEquivalentTLogReuse(TLogClient);
  bindEquivalentTLogReuse(TLogClient);
  const client = new TLogClient();
  await expect(client.createEntry(proposed)).resolves.toEqual(existing);
  expect(fetched).toEqual([entryId]);
  conflicted = false;
  await expect(client.createEntry(proposed)).resolves.toBe("created");
  expect(fetched).toEqual([entryId]);
});

test("a conflict for a different artifact, signature, or certificate is rejected", async () => {
  const proposed = proposal();
  const parsed = JSON.parse(Buffer.from(logged(proposed).body, "base64").toString()) as { spec: { payloadHash: { value: string }, signatures: [{ signature: string }] } };
  const correctHash = parsed.spec.payloadHash.value;
  parsed.spec.payloadHash.value = "aa".repeat(32);
  const wrongHash = { body: Buffer.from(JSON.stringify(parsed)).toString("base64") };
  parsed.spec.payloadHash.value = correctHash;
  parsed.spec.signatures[0].signature = "different-signature";
  const wrongSignature = { body: Buffer.from(JSON.stringify(parsed)).toString("base64") };
  for (const existing of [logged(proposal("other")), wrongHash, wrongSignature, logged(proposed, Buffer.from("other-certificate"))]) {
    expect(() => assertDsseEntryMatchesProposed(existing, proposed)).toThrow("does not match");
    class TLogClient {
      rekor = { getEntry: async () => existing };
      async createEntry(_proposed: Proposed): Promise<unknown> { throw conflict(); }
    }
    bindEquivalentTLogReuse(TLogClient);
    await expect(new TLogClient().createEntry(proposed)).rejects.toThrow("does not match");
  }
});

test("unrelated signer failures and missing fetch clients stay failures", async () => {
  class TLogClient {
    rekor = {};
    async createEntry(_proposed: Proposed): Promise<unknown> { throw new Error("network down"); }
  }
  bindEquivalentTLogReuse(TLogClient);
  await expect(new TLogClient().createEntry(proposal())).rejects.toThrow("network down");
  class MissingFetch {
    rekor = {};
    async createEntry(_proposed: Proposed): Promise<unknown> { throw conflict(); }
  }
  bindEquivalentTLogReuse(MissingFetch);
  await expect(new MissingFetch().createEntry(proposal())).rejects.toThrow("Failed to fetch");
});

test("release validation runs the conflict tests before provenance generation", async () => {
  const workflow = Bun.YAML.parse(await readFile(new URL("../.github/workflows/release-code.yml", import.meta.url), "utf8")) as {
    jobs: { validate: { steps: { run?: string }[] } },
  };
  const steps = workflow.jobs.validate.steps;
  const tests = steps.find(step => step.run?.includes("bun test"));
  const provenance = steps.find(step => step.run?.includes("code-bootstrap-provenance.cjs generate"));
  expect(tests?.run).toContain("tests/code-bootstrap-provenance.test.ts");
  expect(steps.indexOf(tests!)).toBeLessThan(steps.indexOf(provenance!));
});
