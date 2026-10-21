import { describe, expect, it } from "vitest";
import {
	NativePlatformReadConfigSchema,
	readPublishedNativePlatformReadConfig,
	workflowNativePlatformReadProblems,
} from "../native-platform-read-config";

const config = {
	toolName: "fabric_get_project_pm_connection",
	arguments: "{}",
};
const node = { id: "read", type: "native-platform-read", data: { config } };

describe("native platform read configuration", () => {
	it("reads only the selected published native node", () => {
		expect(
			readPublishedNativePlatformReadConfig(
				[{ ...node, id: "other" }, node],
				"read",
			),
		).toEqual(config);
		expect(() =>
			readPublishedNativePlatformReadConfig(
				[{ ...node, type: "mcp-tool" }],
				"read",
			),
		).toThrow();
		expect(() =>
			readPublishedNativePlatformReadConfig([], "read"),
		).toThrow();
	});

	it.each([
		{ ...config, toolName: "{{Choose.result}}" },
		{ ...config, toolName: "fabric_delete_frame" },
		{ ...config, arguments: {} },
		{ ...config, arguments: "x".repeat(16385) },
		{ ...config, organizationId: "other" },
	])("rejects undeclared authority and nonliteral tools", (invalid) => {
		expect(NativePlatformReadConfigSchema.safeParse(invalid).success).toBe(
			false,
		);
		expect(
			workflowNativePlatformReadProblems([
				{ ...node, data: { config: invalid } },
			]),
		).toEqual([
			expect.stringContaining("invalid native read configuration"),
		]);
	});

	it("accepts JSON argument references and ignores unrelated nodes", () => {
		expect(
			NativePlatformReadConfigSchema.parse({
				...config,
				arguments: "{{Prepare.result}}",
			}).arguments,
		).toBe("{{Prepare.result}}");
		expect(
			workflowNativePlatformReadProblems([
				node,
				{ id: "other", type: "trigger" },
			]),
		).toEqual([]);
		expect(workflowNativePlatformReadProblems(null)).toEqual([]);
	});
});
