import { describe, expect, it } from "vitest";
import { renderTemplate, validateTemplate } from "../template-renderer";

describe("validateTemplate — HANDLEBARS", () => {
	it("rejects an unbalanced block helper", () => {
		// Handlebars.compile() is lazy: it returns a function without parsing,
		// so validation has to invoke it to surface the parse error.
		const result = validateTemplate("HANDLEBARS", "{{#if x}}broken");
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/Parse error/i);
	});

	it("rejects an unknown closing tag", () => {
		const result = validateTemplate("HANDLEBARS", "{{#if x}}a{{/unless}}");
		expect(result.valid).toBe(false);
	});

	it("accepts a valid template with blocks and triple-stache", () => {
		const result = validateTemplate(
			"HANDLEBARS",
			"Hello {{{name}}}{{#if extra}} and {{{extra}}}{{/if}}",
		);
		expect(result.valid).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it("accepts a template with no variables at all", () => {
		expect(validateTemplate("HANDLEBARS", "plain text").valid).toBe(true);
	});
});

describe("validateTemplate — other formats are unchanged", () => {
	it("accepts PLAIN_TEXT and MARKDOWN unconditionally", () => {
		expect(validateTemplate("PLAIN_TEXT", "{{#if x}}").valid).toBe(true);
		expect(validateTemplate("MARKDOWN", "{{#if x}}").valid).toBe(true);
	});

	it("rejects invalid LIQUID", () => {
		expect(validateTemplate("LIQUID", "{% if x %}").valid).toBe(false);
	});
});

describe("renderTemplate — escaping contract", () => {
	it("escapes double-stache and preserves triple-stache", async () => {
		const vars = { a: 'A & B <c> "q"' };
		const double = await renderTemplate({
			format: "HANDLEBARS",
			template: "{{a}}",
			variables: vars,
		});
		const triple = await renderTemplate({
			format: "HANDLEBARS",
			template: "{{{a}}}",
			variables: vars,
		});
		expect(double.rendered).toBe("A &amp; B &lt;c&gt; &quot;q&quot;");
		expect(triple.rendered).toBe('A & B <c> "q"');
	});
});
