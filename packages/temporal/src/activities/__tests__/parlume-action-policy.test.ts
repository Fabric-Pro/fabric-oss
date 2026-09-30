import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	parlumeActionArguments,
	parlumeFingerprint,
	parlumeToolFingerprint,
	parseParlumeDecision,
} from "../parlume-action-policy";

describe("Parlume approval decisions", () => {
	it.each(["confirm", "Yes, confirm.", "Go ahead!", "yes please"])(
		"accepts a complete explicit decision: %s",
		(text) => {
			expect(parseParlumeDecision(text)).toBe("confirm");
		},
	);
	it.each([
		"confirm and delete the rest",
		"she said confirm",
		"yes but change the title",
		"I confirm that the project exists",
		"yes",
	])("does not infer approval from ambiguous speech: %s", (text) => {
		expect(parseParlumeDecision(text)).toBeNull();
	});
	it("cancels without interpreting an action", () =>
		expect(parseParlumeDecision("Cancel it.")).toBe("cancel"));
	it("binds approval to payload content, independent of object key order", () => {
		expect(parlumeFingerprint({ a: 1, b: { c: 2 } })).toBe(
			parlumeFingerprint({ b: { c: 2 }, a: 1 }),
		);
		expect(parlumeFingerprint({ title: "First" })).not.toBe(
			parlumeFingerprint({ title: "Second" }),
		);
	});
	it("invalidates a changed tool schema", () => {
		expect(
			parlumeToolFingerprint({
				name: "create_issue",
				inputSchema: z.object({ title: z.string() }),
			}),
		).not.toBe(
			parlumeToolFingerprint({
				name: "create_issue",
				inputSchema: z.object({ title: z.string().min(5) }),
			}),
		);
	});
	it("binds only stable source identity when loader metadata is present", () => {
		const definition = {
			name: "connection_create_issue",
			inputSchema: z.object({ title: z.string() }),
		};
		const source = {
			configId: "connection",
			originalName: "create_issue",
			serverName: "Issue provider",
		};
		expect(parlumeToolFingerprint({ ...definition, source })).toBe(
			parlumeToolFingerprint({
				...definition,
				source: {
					configId: source.configId,
					originalName: source.originalName,
				},
			}),
		);
	});
	it("rejects secret-bearing arguments without modifying executable payloads", () => {
		expect(() =>
			parlumeActionArguments({ nested: { apiKey: "example" } }),
		).toThrow("credentials");
		expect(
			parlumeActionArguments({
				title: "A synthetic issue",
				assigned: "example-user",
			}),
		).toEqual({ title: "A synthetic issue", assigned: "example-user" });
	});
});
