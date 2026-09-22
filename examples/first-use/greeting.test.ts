import { expect, test } from "bun:test";
import { greeting } from "./greeting";
test("greets a person", () => expect(greeting("Ada")).toBe("Hello, Ada!"));
