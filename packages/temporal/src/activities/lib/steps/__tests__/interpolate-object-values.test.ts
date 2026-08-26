/**
 * Referencing a field that holds an object or an array.
 *
 * `String({})` is `"[object Object]"`, and that is what used to reach AI
 * prompts and Slack messages. The reference resolved, so nothing was recorded
 * as unresolved and no warning was logged — the data was simply gone, replaced
 * by a string that looks like a bug report.
 *
 * This is the shape the AI generator emits by default: a trigger node outputs
 * `{ triggered, data }` and generated graphs reference `{{Trigger.data}}`, so
 * the broken form was the one users got without asking for it. Verified
 * against the live generator on 2026-08-08, which produced
 * `{{Webhook Trigger.data}}` inside an AI prompt.
 */

import { describe, expect, it } from "vitest";
import {
	interpolateTemplate,
	interpolateTemplateWithDiagnostics,
} from "../utils";

describe("interpolating a non-scalar value", () => {
	it("serialises an object instead of stringifying it", () => {
		const result = interpolateTemplate(
			"Payload: {{Webhook Trigger.data}}",
			{
				"Webhook Trigger": {
					triggered: true,
					data: { body: "hello world", source: "webhook" },
				},
			},
		);

		expect(result).toBe(
			'Payload: {"body":"hello world","source":"webhook"}',
		);
		expect(result).not.toContain("[object Object]");
	});

	it("serialises an array", () => {
		expect(
			interpolateTemplate("Results: {{Search.results}}", {
				Search: { results: ["a", "b"] },
			}),
		).toBe('Results: ["a","b"]');
	});

	it("leaves scalars exactly as they were", () => {
		expect(
			interpolateTemplate("{{A.text}} / {{A.count}} / {{A.ok}}", {
				A: { text: "plain", count: 7, ok: false },
			}),
		).toBe("plain / 7 / false");
	});

	it("still records nothing as unresolved when the value is an object", () => {
		const { unresolved } = interpolateTemplateWithDiagnostics(
			"{{Node.obj}}",
			{ Node: { obj: { a: 1 } } },
		);

		expect(unresolved).toEqual([]);
	});

	it("escapes the serialised form when the template is embedded in JSON", () => {
		// The `escapeForJson` callers splice the result into a JSON string
		// literal, so the quotes JSON.stringify introduces have to be escaped
		// or the surrounding document stops parsing.
		const result = interpolateTemplate(
			'{"note": "{{A.obj}}"}',
			{
				A: { obj: { k: "v" } },
			},
			{ escapeForJson: true },
		);

		expect(() => JSON.parse(result)).not.toThrow();
		expect(JSON.parse(result).note).toBe('{"k":"v"}');
	});
});
