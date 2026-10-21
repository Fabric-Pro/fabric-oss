import { describe, expect, it } from "vitest";
import {
	readPublishedWorkspaceDataNode,
	workflowWorkspaceDataProblems,
	WorkspaceDataReadConfigSchema,
	WorkspaceDataWriteConfigSchema,
} from "../workspace-data-config";

const config = {
	frameId: "workspace",
	collection: "state",
	key: "{{Selection.key}}",
	scope: "shared",
};

describe("Workspace data graph configuration", () => {
	it("accepts distinct read/write nodes and requires explicit concurrency", () => {
		expect(WorkspaceDataReadConfigSchema.parse(config)).toEqual(config);
		expect(
			WorkspaceDataWriteConfigSchema.safeParse({ ...config, value: "{}" })
				.success,
		).toBe(false);
		expect(
			WorkspaceDataWriteConfigSchema.parse({
				...config,
				value: "{{Transform.result}}",
				expectedVersion: "{{Read.version}}",
			}),
		).toMatchObject({ expectedVersion: "{{Read.version}}" });
	});

	it.each([
		{ frameId: "{{Input.frame}}" },
		{ collection: "{{Input.collection}}" },
		{ scope: "{{Input.scope}}" },
		{ collection: "$files" },
		{ organizationId: "forged" },
		{ mode: "write" },
		{ scope: "all" },
	])("rejects authority templates and unknown config %j", (change) => {
		expect(
			WorkspaceDataReadConfigSchema.safeParse({ ...config, ...change })
				.success,
		).toBe(false);
	});

	it.each(["workspace-data-read", "workspace-data-write"])(
		"validates malformed %s nodes before save or publish",
		(type) => {
			const nodes = [
				{
					id: "data",
					type,
					data: { config: { ...config, frameId: "" } },
				},
			];
			expect(workflowWorkspaceDataProblems(nodes)).toHaveLength(1);
			expect(() =>
				readPublishedWorkspaceDataNode(nodes, "data"),
			).toThrow();
		},
	);

	it("reads only the named immutable node and ignores unrelated graph steps", () => {
		const nodes = [
			{ id: "read", type: "workspace-data-read", data: { config } },
		];
		expect(workflowWorkspaceDataProblems(nodes)).toEqual([]);
		expect(
			readPublishedWorkspaceDataNode(nodes, "read").data.config,
		).toEqual(config);
		expect(() =>
			readPublishedWorkspaceDataNode(nodes, "missing"),
		).toThrow();
		expect(workflowWorkspaceDataProblems([{ type: "trigger" }])).toEqual(
			[],
		);
	});
});
