export const reasoningFixtures = [
  { id: "facts", files: { "a.txt": "ALPHA: apples\n", "b.txt": "BETA: bananas\n" },
    task: 'Return JSON with alpha (fruit named ALPHA), beta (fruit named BETA), and explanation. Do not invent quantities or other facts.',
    expected: { alpha: "apples", beta: "bananas" } },
  { id: "arithmetic", files: { "a.txt": "Stock: 12. Reserved: 5.\n", "b.txt": "Incoming usable: 4. Damaged units to subtract: 2. Reorder if available < 10.\n" },
    task: 'Compute available = stock - reserved + incoming usable - damaged. Return JSON with available (number), reorder (boolean), and explanation.',
    expected: { available: 9, reorder: true } },
  { id: "code-review", files: { "a.txt": "export function canAccess(age: number, banned: boolean) { return age >= 18 || !banned; }\n", "b.txt": "Policy: access requires age >= 18 AND not banned. Evaluate corrected access for (17,false), (20,true), (20,false), in that order.\n" },
    task: 'Review the code against the policy. Return JSON with bug (OR_INSTEAD_OF_AND or NO_BUG), replacement (the corrected return statement), cases (three booleans in the requested order), and explanation.',
    expected: { bug: "OR_INSTEAD_OF_AND", replacement: "return age >= 18 && !banned;", cases: [false, false, true] } }
] as const;

export function gradeReasoningAnswer(fixtureId: string, answer: string) {
  const fixture = reasoningFixtures.find(f => f.id === fixtureId)!;
  try {
    const parsed = JSON.parse(answer);
    const keys = Object.keys(parsed).sort(), expectedKeys = [...Object.keys(fixture.expected), "explanation"].sort();
    const format = JSON.stringify(keys) === JSON.stringify(expectedKeys) && typeof parsed.explanation === "string";
    const facts = Object.entries(fixture.expected).every(([key, value]) => key === "replacement"
      ? typeof parsed[key] === "string" && parsed[key].replace(/\s/g, "") === String(value).replace(/\s/g, "")
      : JSON.stringify(parsed[key]) === JSON.stringify(value));
    const words = typeof parsed.explanation === "string" ? parsed.explanation.trim().split(/\s+/).filter(Boolean).length : 0;
    return { format, facts, words, length: words >= 80 && words <= 100, pass: format && facts && words >= 80 && words <= 100 };
  } catch { return { format: false, facts: false, words: 0, length: false, pass: false }; }
}
