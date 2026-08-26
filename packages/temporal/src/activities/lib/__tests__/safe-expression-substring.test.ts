/**
 * Condition nodes: substring tests.
 *
 * `{{Node.text}}.includes('...')` is the shape the builder advertises — the AI
 * generator is instructed to emit it and the customer docs show it — but the
 * evaluator only understood comparisons. With no comparison operator present
 * the expression fell through to a truthiness check on the whole interpolated
 * string, which is non-empty whenever the referenced node produced any text.
 *
 * That is the dangerous kind of wrong: the condition did not error, it just
 * took its true branch every time, so every run went down one path and the
 * false branch was dead code nobody noticed.
 */

import { describe, expect, it } from "vitest";
import { safeEvaluateExpression } from "../safe-expression-evaluator";

describe("substring conditions", () => {
	it("is true when the referenced text contains the needle", () => {
		expect(
			safeEvaluateExpression(
				"{{Generate Text.text}}.includes('negative')",
				{
					"Generate Text": { text: "sentiment: negative" },
				},
			),
		).toBe(true);
	});

	it("is FALSE when it does not — the case that always passed before", () => {
		expect(
			safeEvaluateExpression(
				"{{Generate Text.text}}.includes('negative')",
				{
					"Generate Text": { text: "sentiment: positive" },
				},
			),
		).toBe(false);
	});

	it("handles double quotes as well as single", () => {
		expect(
			safeEvaluateExpression('{{Summary.text}}.includes("urgent")', {
				Summary: { text: "this is urgent" },
			}),
		).toBe(true);
	});

	it("is false for an empty subject rather than throwing", () => {
		expect(
			safeEvaluateExpression("{{Missing.text}}.includes('x')", {}),
		).toBe(false);
	});

	it("composes with the logical operators", () => {
		const context = { Out: { text: "build failed on windows" } };
		expect(
			safeEvaluateExpression(
				"{{Out.text}}.includes('failed') && {{Out.text}}.includes('windows')",
				context,
			),
		).toBe(true);
		expect(
			safeEvaluateExpression(
				"{{Out.text}}.includes('failed') && {{Out.text}}.includes('linux')",
				context,
			),
		).toBe(false);
	});

	it("resolves a node label containing spaces in a plain comparison too", () => {
		// Not specific to `includes`: the interpolation key used to be `\w`-only,
		// so every default label ("Generate Text", "HTTP Request", "Send Slack
		// Message") failed to resolve on any expression form.
		expect(
			safeEvaluateExpression(
				'{{Send Slack Message.channel}} == "#general"',
				{
					"Send Slack Message": { channel: "#general" },
				},
			),
		).toBe(true);
		expect(
			safeEvaluateExpression(
				'{{Send Slack Message.channel}} == "#other"',
				{
					"Send Slack Message": { channel: "#general" },
				},
			),
		).toBe(false);
	});

	it("leaves ordinary comparisons alone", () => {
		expect(
			safeEvaluateExpression("{{Score.value}} > 7", {
				Score: { value: 9 },
			}),
		).toBe(true);
		expect(
			safeEvaluateExpression("{{Score.value}} > 7", {
				Score: { value: 3 },
			}),
		).toBe(false);
	});
});
