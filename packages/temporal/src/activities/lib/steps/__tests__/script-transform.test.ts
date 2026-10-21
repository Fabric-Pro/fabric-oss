import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execution: vi.fn(),
	version: vi.fn(),
	permission: vi.fn(),
	access: vi.fn(),
	executeCode: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		workflowExecution: { findFirst: mocks.execution },
		workflowVersion: { findFirst: mocks.version },
	},
	canRunOrganizationWorkflows: mocks.permission,
	hasProjectAccess: mocks.access,
}));
vi.mock("@repo/sandbox", () => ({
	createSandboxClient: () => ({ executeCode: mocks.executeCode }),
}));
import { executeScriptTransformStep } from "../script-transform";

const config = {
	code: "return { count: inputs.source.length };",
	language: "javascript",
};
const params = {
	userId: "owner",
	organizationId: "example-org",
	workflowId: "workflow",
	executionId: "execution",
	nodeId: "script",
	projectId: "project",
	nodeConfig: config,
	inputs: { source: [1, 2], userId: "untrusted" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.permission.mockResolvedValue(true);
	mocks.access.mockResolvedValue(true);
	mocks.execution.mockResolvedValue({
		id: "execution",
		workflowId: "workflow",
		version: 3,
		triggerType: "MANUAL",
	});
	mocks.version.mockResolvedValue({
		nodes: [{ id: "script", type: "script-transform", data: { config } }],
	});
	mocks.executeCode.mockResolvedValue({
		logs: [],
		results: [{ type: "json", json: { count: 2 } }],
	});
});

describe("Script Transform workflow step", () => {
	it.each(["MANUAL", "SCHEDULE"])(
		"uses the owned row for %s execution context",
		async (triggerType) => {
			mocks.execution.mockResolvedValue({
				id: "execution",
				workflowId: "workflow",
				version: 3,
				triggerType,
			});
			await executeScriptTransformStep({
				...params,
				inputs: {
					...params.inputs,
					execution: { triggerType: "forged" },
					source: "forged",
				},
			});
			expect(mocks.executeCode).toHaveBeenCalledWith(
				"owner",
				"example-org",
				expect.objectContaining({
					execution: {
						executionId: "execution",
						workflowId: "workflow",
						version: 3,
						triggerType,
					},
				}),
			);
		},
	);

	it("selects input aliases before checking the byte budget and normalizes published config", async () => {
		const value = { text: "x".repeat(40000) };
		const selected = { ...config, inputKeys: ["$source"] };
		mocks.version.mockResolvedValue({
			nodes: [
				{
					id: "script",
					type: "script-transform",
					data: { config: selected },
				},
			],
		});
		const result = await executeScriptTransformStep({
			...params,
			nodeConfig: { ...config, inputKeys: '["$source"]' },
			inputs: { $source: value, Source: value },
		});
		expect(result.success).toBe(true);
		const sent = mocks.executeCode.mock.calls[0][2];
		expect(sent.inputs).toEqual({ $source: value });
		expect(sent).not.toHaveProperty("inputKeys");
	});

	it("refuses missing selected input keys", async () => {
		const selected = { ...config, inputKeys: ["$missing"] };
		mocks.version.mockResolvedValue({
			nodes: [
				{
					id: "script",
					type: "script-transform",
					data: { config: selected },
				},
			],
		});
		expect(
			await executeScriptTransformStep({
				...params,
				nodeConfig: selected,
			}),
		).toMatchObject({
			success: false,
			error: "Script input key not found: $missing",
		});
		expect(mocks.executeCode).not.toHaveBeenCalled();
	});

	it("still enforces the input byte budget after projection", async () => {
		const selected = { ...config, inputKeys: ["$source"] };
		mocks.version.mockResolvedValue({
			nodes: [
				{
					id: "script",
					type: "script-transform",
					data: { config: selected },
				},
			],
		});
		expect(
			(
				await executeScriptTransformStep({
					...params,
					nodeConfig: selected,
					inputs: { $source: "x".repeat(65536) },
				})
			).success,
		).toBe(false);
		expect(mocks.executeCode).not.toHaveBeenCalled();
	});
	it("uses the trusted execution actor and returns JSON for following graph steps", async () => {
		expect(await executeScriptTransformStep(params)).toEqual({
			success: true,
			output: { result: { count: 2 }, logs: [] },
		});
		expect(mocks.executeCode).toHaveBeenCalledWith(
			"owner",
			"example-org",
			expect.objectContaining({
				inputs: params.inputs,
				code: config.code,
			}),
		);
		expect(mocks.execution.mock.calls[0][0].where).toMatchObject({
			userId: "owner",
			organizationId: "example-org",
			workflow: {
				userId: "owner",
				organizationId: "example-org",
				projectId: "project",
			},
		});
	});

	it("rechecks permission after publication", async () => {
		mocks.permission.mockResolvedValue(false);
		expect((await executeScriptTransformStep(params)).success).toBe(false);
		expect(mocks.executeCode).not.toHaveBeenCalled();
	});

	it("uses the shared parser for reordered published configuration", async () => {
		mocks.version.mockResolvedValue({
			nodes: [
				{
					id: "script",
					type: "script-transform",
					data: {
						config: { language: "javascript", code: config.code },
					},
				},
			],
		});
		expect((await executeScriptTransformStep(params)).success).toBe(true);
	});

	it("rejects modified source, missing snapshot, or foreign execution before execution", async () => {
		expect(
			(
				await executeScriptTransformStep({
					...params,
					nodeConfig: { ...config, code: "return 42" },
				})
			).success,
		).toBe(false);
		mocks.version.mockResolvedValue(null);
		expect((await executeScriptTransformStep(params)).success).toBe(false);
		mocks.execution.mockResolvedValue(null);
		expect((await executeScriptTransformStep(params)).success).toBe(false);
		expect(mocks.executeCode).not.toHaveBeenCalled();
	});

	it("refuses oversized input, missing organization, and supplied authority fields", async () => {
		expect(
			(
				await executeScriptTransformStep({
					...params,
					inputs: { text: "x".repeat(65536) },
				})
			).success,
		).toBe(false);
		expect(
			(
				await executeScriptTransformStep({
					...params,
					organizationId: undefined,
				})
			).success,
		).toBe(false);
		expect(
			(
				await executeScriptTransformStep({
					...params,
					nodeConfig: { ...config, organizationId: "foreign" },
				})
			).success,
		).toBe(false);
		expect(mocks.executeCode).not.toHaveBeenCalled();
	});

	it("propagates a failed script as a failed step", async () => {
		mocks.executeCode.mockResolvedValue({
			logs: [{ type: "stderr", text: "example" }],
			error: "example failure",
		});
		expect(await executeScriptTransformStep(params)).toMatchObject({
			success: false,
			error: "example failure",
		});
	});
});
