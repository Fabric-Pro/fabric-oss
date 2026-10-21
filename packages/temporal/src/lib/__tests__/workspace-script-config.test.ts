import {
	DYNAMIC_CODE_LIMITS,
	ExecuteCodeRequestSchema,
	ExecuteCodeResponseSchema,
} from "@repo/sandbox/dynamic-worker";
import { describe, expect, it } from "vitest";
import {
	WorkspaceScriptConfigSchema,
	workflowScriptProblems,
	readPublishedScriptConfig,
} from "../workspace-script-config";

describe("agent-authored script configuration", () => {
	it("normalizes optional input keys without changing their names", () => {
		const config = { code: "return inputs", language: "javascript" };
		expect(
			WorkspaceScriptConfigSchema.parse({
				...config,
				inputKeys: '["$source", "Source label"]',
			}).inputKeys,
		).toEqual(["$source", "Source label"]);
		expect(
			WorkspaceScriptConfigSchema.parse({
				...config,
				inputKeys: ["$source"],
			}).inputKeys,
		).toEqual(["$source"]);
		expect(
			WorkspaceScriptConfigSchema.parse({ ...config, inputKeys: "" })
				.inputKeys,
		).toBeUndefined();
	});

	it.each(
		[
			[],
			[""],
			[" "],
			["$source", "$source"],
			["x".repeat(257)],
			Array.from({ length: 33 }, (_, index) => `key${index}`),
			"not JSON",
			'{"key":"value"}',
		].map((inputKeys) => ({ inputKeys })),
	)("refuses invalid input key selection $inputKeys", ({ inputKeys }) => {
		expect(
			WorkspaceScriptConfigSchema.safeParse({
				code: "return inputs",
				language: "javascript",
				inputKeys,
			}).success,
		).toBe(false);
	});

	it("never accepts execution metadata as editable script config", () => {
		expect(
			WorkspaceScriptConfigSchema.safeParse({
				code: "return inputs",
				language: "javascript",
				execution: {
					executionId: "forged",
					workflowId: "workflow",
					version: 1,
					triggerType: "SCHEDULE",
				},
			}).success,
		).toBe(false);
	});
	it("accepts an async function body and defaults a short response deadline", () => {
		expect(
			WorkspaceScriptConfigSchema.parse({
				code: "return inputs.source",
				language: "javascript",
			}),
		).toEqual({
			code: "return inputs.source",
			language: "javascript",
			timeout: 5000,
		});
	});

	it.each([
		{ code: " ", language: "javascript" },
		{
			code: "x".repeat(DYNAMIC_CODE_LIMITS.sourceBytes + 1),
			language: "javascript",
		},
		{
			code: "é".repeat(DYNAMIC_CODE_LIMITS.sourceBytes),
			language: "javascript",
		},
		{ code: "return null", language: "python" },
		{ code: "return null", language: "javascript", timeout: 10001 },
		{
			code: "return null",
			language: "javascript",
			env: { SECRET: "untrusted" },
		},
		{ code: "return null", language: "javascript", userId: "untrusted" },
	])("rejects invalid or authority-bearing config %j", (config) => {
		expect(WorkspaceScriptConfigSchema.safeParse(config).success).toBe(
			false,
		);
	});

	it("rejects oversized JSON inputs before a sandbox call", () => {
		expect(
			ExecuteCodeRequestSchema.safeParse({
				code: "return null",
				language: "javascript",
				inputs: { text: "x".repeat(DYNAMIC_CODE_LIMITS.inputBytes) },
			}).success,
		).toBe(false);
	});

	it("validates draft and publish script nodes while leaving unrelated nodes alone", () => {
		expect(workflowScriptProblems([{ type: "trigger" }])).toEqual([]);
		expect(
			workflowScriptProblems([
				{
					id: "transform",
					type: "script-transform",
					data: {
						config: {
							code: "return inputs",
							language: "javascript",
						},
					},
				},
			]),
		).toEqual([]);
		expect(
			workflowScriptProblems([
				{
					id: "transform",
					type: "script-transform",
					data: { config: { code: "" } },
				},
			]),
		).toHaveLength(1);
	});

	it.each(["malformed", null, [], 7])(
		"refuses a known script node with malformed data %j",
		(data) => {
			const nodes = [{ id: "transform", type: "script-transform", data }];
			expect(workflowScriptProblems(nodes)).toHaveLength(1);
			expect(() =>
				readPublishedScriptConfig(nodes, "transform"),
			).toThrow();
		},
	);

	it("parses published script configuration through the same schema as publication", () => {
		const nodes = [
			{
				id: "transform",
				type: "script-transform",
				data: {
					config: { code: "return null", language: "javascript" },
				},
			},
		];
		expect(workflowScriptProblems(nodes)).toEqual([]);
		expect(readPublishedScriptConfig(nodes, "transform")).toEqual({
			code: "return null",
			language: "javascript",
			timeout: 5000,
		});
		expect(() => readPublishedScriptConfig(nodes, "missing")).toThrow();
	});

	it("does not accept excessive logs or a non-JSON result from a runtime", () => {
		const base = {
			code: "return null",
			executionCount: 1,
			executionTime: 1,
		};
		expect(
			ExecuteCodeResponseSchema.safeParse({
				...base,
				logs: Array.from({ length: 101 }, () => ({
					type: "stdout",
					text: "x",
				})),
			}).success,
		).toBe(false);
		expect(
			ExecuteCodeResponseSchema.safeParse({
				...base,
				logs: [],
				results: [{ type: "json", json: undefined }],
			}).success,
		).toBe(false);
	});
});
