/**
 * An unresolved `{{...}}` reference must never survive into the value a step
 * sends outward. It used to: the interpolator returned the literal placeholder,
 * so a typo — or a declared output field the step never actually returned —
 * shipped as data. Slack messages read "{{Create Ticket.id}}"; emails carried
 * raw placeholders. Upstream (vercel-labs/workflow-builder-template) has the
 * same behaviour; this is a deliberate divergence.
 */

import { describe, expect, it, vi } from "vitest";
import {
	interpolateTemplate,
	interpolateTemplateWithDiagnostics,
} from "../utils";

describe("interpolateTemplateWithDiagnostics", () => {
	it("resolves a simple variable", () => {
		expect(
			interpolateTemplateWithDiagnostics("Hi {{name}}", { name: "Ada" }),
		).toEqual({ text: "Hi Ada", unresolved: [] });
	});

	it("resolves a node reference with spaces in the label", () => {
		expect(
			interpolateTemplateWithDiagnostics("{{Generate Text.text}}", {
				"Generate Text": { text: "hello" },
			}).text,
		).toBe("hello");
	});

	it("resolves a nested property path", () => {
		expect(
			interpolateTemplateWithDiagnostics("{{Scrape.metadata.title}}", {
				Scrape: { metadata: { title: "Docs" } },
			}).text,
		).toBe("Docs");
	});

	it("erases an unresolved reference instead of emitting the placeholder", () => {
		const result = interpolateTemplateWithDiagnostics(
			"Ticket {{Create Ticket.id}} filed",
			{ "Create Ticket": { issueId: "abc" } },
		);

		expect(result.text).toBe("Ticket  filed");
		expect(result.text).not.toContain("{{");
		expect(result.unresolved).toEqual(["Create Ticket.id"]);
	});

	it("erases an unknown node entirely", () => {
		const result = interpolateTemplateWithDiagnostics("{{Nope.field}}", {});

		expect(result.text).toBe("");
		expect(result.unresolved).toEqual(["Nope.field"]);
	});

	it("reports every unresolved reference, not just the first", () => {
		const result = interpolateTemplateWithDiagnostics(
			"{{a.x}} and {{b.y}} and {{c}}",
			{},
		);

		expect(result.unresolved).toEqual(["a.x", "b.y", "c"]);
	});

	it("distinguishes a resolved falsy value from an unresolved one", () => {
		const result = interpolateTemplateWithDiagnostics(
			"count={{Search.count}}",
			{ Search: { count: 0 } },
		);

		expect(result.text).toBe("count=0");
		expect(result.unresolved).toEqual([]);
	});

	it("escapes for JSON when asked", () => {
		expect(
			interpolateTemplateWithDiagnostics(
				"{{v}}",
				{ v: 'a"b' },
				{
					escapeForJson: true,
				},
			).text,
		).toBe('a\\"b');
	});
});

describe("interpolateTemplate", () => {
	it("returns the resolved string", () => {
		expect(interpolateTemplate("Hi {{name}}", { name: "Ada" })).toBe(
			"Hi Ada",
		);
	});

	it("warns when a reference cannot be resolved", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {
			// expected diagnostic
		});

		expect(interpolateTemplate("{{Missing.field}}", {})).toBe("");
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("{{Missing.field}}"),
		);

		warn.mockRestore();
	});

	it("stays quiet when everything resolves", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {
			// should not fire
		});

		interpolateTemplate("{{a}}", { a: 1 });
		expect(warn).not.toHaveBeenCalled();

		warn.mockRestore();
	});
});
