import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../src/frontmatter";

const skill = `---
name: example-qa-test
effort: max
description: Use when the user provides an ADO work item ID. Do NOT use for TC writing.
argument-hint: "[US/Bug ID(s)]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep
---

# Example QA Test Workflow
Body here.
`;

describe("parseFrontmatter", () => {
	it("extracts name, description, and every scalar field", () => {
		const fm = parseFrontmatter(skill);
		expect(fm.name).toBe("example-qa-test");
		expect(fm.description).toBe(
			"Use when the user provides an ADO work item ID. Do NOT use for TC writing.",
		);
		expect(fm.fields["argument-hint"]).toBe("[US/Bug ID(s)]");
		expect(fm.fields["disable-model-invocation"]).toBe("true");
		expect(fm.fields.effort).toBe("max");
		expect(fm.body.startsWith("# Example QA Test Workflow")).toBe(true);
	});
	it("returns nulls and the whole text as body when there is no frontmatter", () => {
		const fm = parseFrontmatter("# Just a doc\n");
		expect(fm.name).toBeNull();
		expect(fm.description).toBeNull();
		expect(fm.body).toBe("# Just a doc\n");
	});
	it("tolerates CRLF and an unterminated block (treated as no frontmatter)", () => {
		expect(parseFrontmatter("---\r\nname: x\r\n---\r\nbody").name).toBe(
			"x",
		);
		expect(parseFrontmatter("---\nname: x\nbody").name).toBeNull();
	});
	it("keeps list-valued keys as their raw text", () => {
		const fm = parseFrontmatter(
			'---\npaths:\n  - .claude/skills/**\n  - "**/*.md"\n---\n',
		);
		expect(fm.fields.paths).toBe('- .claude/skills/**\n- "**/*.md"');
	});
});
