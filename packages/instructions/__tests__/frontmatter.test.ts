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
	it("decodes an escaped quote inside a double-quoted value", () => {
		const fm = parseFrontmatter(
			'---\nname: "Say \\"hello\\" first"\n---\n',
		);
		expect(fm.name).toBe('Say "hello" first');
	});
	it("decodes an escaped backslash inside a double-quoted value", () => {
		const fm = parseFrontmatter(
			'---\ndescription: "Paths like C:\\\\Users\\\\me"\n---\n',
		);
		expect(fm.description).toBe("Paths like C:\\Users\\me");
	});
	it("leaves other backslash sequences in a double-quoted value untouched", () => {
		const fm = parseFrontmatter('---\nname: "tab\\there \\d+"\n---\n');
		expect(fm.name).toBe("tab\\there \\d+");
	});
	it("still reads a plain title and an apostrophe title exactly", () => {
		expect(
			parseFrontmatter("---\nname: Plain title here\n---\n").name,
		).toBe("Plain title here");
		expect(
			parseFrontmatter('---\nname: "Don\'t repeat the migration"\n---\n')
				.name,
		).toBe("Don't repeat the migration");
		const single = ["---", "name: 'single \\\"quoted'", "---", ""].join(
			"\n",
		);
		expect(parseFrontmatter(single).name).toBe('single \\"quoted');
	});
});
