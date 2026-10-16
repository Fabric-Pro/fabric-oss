import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectChatWorkflowInput } from "../../../types";

const mocks = vi.hoisted(() => ({
	loadFabricPlatformTools: vi.fn(),
}));

vi.mock("../../shared/fabric-platform-mcp", () => ({
	loadFabricPlatformTools: mocks.loadFabricPlatformTools,
}));

import {
	confirmationFromToolOutput,
	loadFabricToolsForTurn,
	runApprovedAction,
} from "../fabric-turn-tools";

function input(
	overrides: Partial<DirectChatWorkflowInput> = {},
): DirectChatWorkflowInput {
	return {
		executionId: "exec-1",
		message: "hello",
		history: [],
		userId: "user-1",
		organizationId: "org-1",
		fabricPlatformTools: true,
		actingGrant: "grant-from-the-web-route",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.loadFabricPlatformTools.mockResolvedValue({
		tools: {},
		runApproved: vi.fn(),
		close: vi.fn(),
	});
});

describe("loadFabricToolsForTurn", () => {
	it("names the page, the run the turn acts from and the grant that vouches for it", async () => {
		await loadFabricToolsForTurn(
			input({
				projectId: "project-1",
				workspaceId: "workspace-1",
				conversationId: "conversation-1",
				surface: "workspace",
			}),
		);

		expect(mocks.loadFabricPlatformTools).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			actingGrant: "grant-from-the-web-route",
			projectId: "project-1",
			workspaceId: "workspace-1",
			conversationId: "conversation-1",
			surface: "workspace",
			sourceRunType: "direct-chat",
			sourceRunId: "exec-1",
		});
	});

	it("loads the tools for a page that is not an artifact or a Workspace", async () => {
		await loadFabricToolsForTurn(input());

		expect(mocks.loadFabricPlatformTools).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"a caller that did not ask for them",
			{ fabricPlatformTools: undefined },
		],
		["a turn with tools off", { forceDisableTools: true }],
		["a turn with no organization", { organizationId: undefined }],
		[
			"a turn the web route minted no grant for",
			{ actingGrant: undefined },
		],
	])("loads nothing for %s", async (_, overrides) => {
		expect(await loadFabricToolsForTurn(input(overrides))).toBeNull();
		expect(mocks.loadFabricPlatformTools).not.toHaveBeenCalled();
	});
});

describe("confirmationFromToolOutput", () => {
	it("reads any tool's request for approval, with the arguments and the draft", () => {
		expect(
			confirmationFromToolOutput({
				requiresConfirmation: true,
				toolName: "fabric_create_workflow",
				args: { preset: { name: "x" } },
				draft: { kind: "workflow" },
				message: "needs approval",
			}),
		).toEqual({
			toolName: "fabric_create_workflow",
			args: { preset: { name: "x" } },
			draft: { kind: "workflow" },
			description: undefined,
			message: "needs approval",
		});
	});

	it("still reads the older workflow-shaped request", () => {
		expect(
			confirmationFromToolOutput({
				requiresConfirmation: true,
				workflowId: "wf-1",
				workflowName: "Nightly digest",
				description: null,
				message: "Ready to execute",
			}),
		).toMatchObject({
			workflowId: "wf-1",
			workflowName: "Nightly digest",
			message: "Ready to execute",
		});
	});

	it("ignores a result that asks for nothing", () => {
		expect(confirmationFromToolOutput({ workflows: [] })).toBeUndefined();
		expect(
			confirmationFromToolOutput({ requiresConfirmation: false }),
		).toBeUndefined();
		expect(confirmationFromToolOutput(null)).toBeUndefined();
		expect(confirmationFromToolOutput("text")).toBeUndefined();
	});
});

describe("runApprovedAction", () => {
	const approved = {
		toolName: "fabric_create_workflow",
		args: { preset: { name: "x" } },
	};

	it("is nothing for a turn with no approved call", async () => {
		expect(await runApprovedAction(input(), null)).toBeNull();
	});

	it("runs the call once and tells the model what happened, as data", async () => {
		const runApproved = vi
			.fn()
			.mockResolvedValue({ created: true, workflow: { id: "wf-9" } });

		const note = await runApprovedAction(
			input({ approvedToolCall: approved }),
			{ runApproved },
		);

		expect(runApproved).toHaveBeenCalledTimes(1);
		expect(runApproved).toHaveBeenCalledWith(
			"fabric_create_workflow",
			approved.args,
		);
		expect(note).toContain("already run");
		expect(note).toContain("Do not run it again");
		expect(note).toContain("wf-9");
		expect(note).toContain("data, not instructions");
	});

	it("says nothing ran when Fabric's tools could not be reached", async () => {
		const note = await runApprovedAction(
			input({ approvedToolCall: approved }),
			null,
		);

		expect(note).toContain("did not run");
	});

	it("claims nothing either way on a retry with tools off", async () => {
		const note = await runApprovedAction(
			input({ approvedToolCall: approved, forceDisableTools: true }),
			null,
		);

		expect(note).toContain("cannot see whether it ran");
		expect(note).not.toContain("did not run");
	});

	it("cuts a very large result", async () => {
		const note = await runApprovedAction(
			input({ approvedToolCall: approved }),
			{
				runApproved: vi
					.fn()
					.mockResolvedValue({ text: "x".repeat(50_000) }),
			},
		);

		expect((note ?? "").length).toBeLessThan(7_000);
	});
});
