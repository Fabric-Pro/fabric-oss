import { ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { assertValidTemplate } from "../lib/assert-valid-template";

describe("assertValidTemplate", () => {
	it("passes a valid Handlebars body", () => {
		expect(() =>
			assertValidTemplate("HANDLEBARS", "Hi {{{name}}}"),
		).not.toThrow();
	});

	it("rejects an unbalanced Handlebars block with BAD_REQUEST", () => {
		try {
			assertValidTemplate("HANDLEBARS", "{{#if x}}broken");
			throw new Error("expected assertValidTemplate to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ORPCError);
			expect((error as ORPCError<any, any>).code).toBe("BAD_REQUEST");
			// The parser's own message is surfaced so the editor can point at
			// the offending line instead of saying "invalid".
			expect((error as ORPCError<any, any>).message).toMatch(
				/Parse error/i,
			);
		}
	});

	it("passes any body when the format does no templating", () => {
		expect(() =>
			assertValidTemplate("PLAIN_TEXT", "{{#if x}}broken"),
		).not.toThrow();
		expect(() =>
			assertValidTemplate("MARKDOWN", "{{#if x}}broken"),
		).not.toThrow();
	});

	it("rejects an invalid Liquid body", () => {
		expect(() => assertValidTemplate("LIQUID", "{% if x %}")).toThrow(
			ORPCError,
		);
	});
});

/**
 * A whitespace-only body is the one invalid input that every parser accepts:
 * it is syntactically perfect in every format and satisfies min(1), yet the
 * agent reading it gets no instructions and no context.
 */
describe("assertValidTemplate blank bodies", () => {
	it.each([
		["spaces", "   "],
		["newlines", "\n\n"],
		["tabs and newlines", "\t \n  \t"],
		// Zero-width characters are not whitespace, so `trim()` leaves them
		// standing and a length check calls them content. Each of these reached
		// a bound prompt version on staging before the guard used
		// `isEffectivelyBlank` (Fizzy #2178 QA).
		["a zero-width space", "\u200B"],
		["a byte order mark", "\uFEFF"],
		["mixed invisibles and whitespace", " \u200B\n\u200D\t\uFEFF "],
	])("rejects a body that is only %s", (_label, template) => {
		try {
			assertValidTemplate("HANDLEBARS", template);
			throw new Error("expected assertValidTemplate to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ORPCError);
			expect((error as ORPCError<any, any>).code).toBe("BAD_REQUEST");
			expect((error as ORPCError<any, any>).message).toBe(
				"Prompt content cannot be empty",
			);
		}
	});

	it("rejects a blank body under a format that does no templating", () => {
		// PLAIN_TEXT and MARKDOWN short-circuit the parser entirely, so this
		// only holds if the blank check runs before the format is considered.
		expect(() => assertValidTemplate("PLAIN_TEXT", "   ")).toThrow(
			ORPCError,
		);
		expect(() => assertValidTemplate("MARKDOWN", "\n")).toThrow(ORPCError);
	});

	it("keeps a body whose visible content is surrounded by whitespace", () => {
		expect(() =>
			assertValidTemplate("HANDLEBARS", "\n  Hi {{{name}}}  \n"),
		).not.toThrow();
	});

	it("keeps a body that merely contains invisible characters", () => {
		// Pasting from a word processor sprinkles these through otherwise
		// ordinary prose. Rejecting on their presence rather than on the
		// absence of everything else would break real prompts.
		expect(() =>
			assertValidTemplate("HANDLEBARS", "Hi\u200B {{{name}}}\uFEFF"),
		).not.toThrow();
	});
});
