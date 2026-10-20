import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	acts: {} as Record<string, ReturnType<typeof vi.fn>>,
	patched: vi.fn((_id: string) => true),
}));

vi.mock("@temporalio/workflow", async () => {
	const actual = await vi.importActual<typeof import("@temporalio/workflow")>(
		"@temporalio/workflow",
	);
	return {
		ActivityFailure: actual.ActivityFailure,
		ApplicationFailure: actual.ApplicationFailure,
		defineQuery: (name: string) => name,
		defineSignal: (name: string) => name,
		setHandler: vi.fn(),
		patched: h.patched,
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		proxyActivities: () =>
			new Proxy(
				{},
				{
					get: (_target, name: string) => {
						h.acts[name] ??= vi.fn(async () => undefined);
						return h.acts[name];
					},
				},
			),
	};
});

const { testCaseSyncWorkflow } = await import(
	"../src/workflows/test-case-sync-workflow"
);

const PATCH = "test-case-sync-link-guard-v1";

const CAPABILITIES = {
	hasPMCapabilities: true,
	detectedType: "fizzy",
	taskUpdate: {
		toolName: "update_card",
		idParam: "card_id",
		titleParam: "title",
		descriptionParam: "description",
		allParams: [],
	},
	taskCreation: {
		toolName: "create_card",
		containerParam: "board_id",
		titleParam: "title",
		descriptionParam: "description",
		allParams: [],
	},
	taskGet: { toolName: "get_card", idParam: "card_id", allParams: [] },
};

function caseRow(id: string, externalId: string | null = null) {
	return {
		id,
		identifier: `TC-${id}`,
		title: "Login works",
		description: null,
		state: "READY",
		priority: "MEDIUM",
		tags: [],
		externalId,
		externalUrl: null,
		currentResult: null,
		steps: [],
	};
}

function input(overrides: Record<string, unknown> = {}) {
	return {
		projectId: "project-1",
		mcpServerId: "server-1",
		mcpConfigId: "config-1",
		containerId: "board-1",
		additionalContext: { account_slug: "example-org" },
		userId: "u-1",
		organizationId: "org-1",
		testCaseIds: ["case-1"],
		direction: "push" as const,
		unsyncedOnly: false,
		...overrides,
	};
}

function act(name: string): ReturnType<typeof vi.fn> {
	h.acts[name] ??= vi.fn(async () => undefined);
	return h.acts[name];
}

beforeEach(() => {
	for (const stub of Object.values(h.acts)) {
		stub.mockReset();
		stub.mockResolvedValue(undefined);
	}
	h.patched.mockReset();
	h.patched.mockImplementation(() => true);
	act("discoverPMToolCapabilities").mockResolvedValue(CAPABILITIES);
	act("getTestCasesToSync").mockResolvedValue([caseRow("case-1")]);
	act("detectAndStampPmPushConflict").mockResolvedValue({
		hasConflict: false,
	});
	act("checkTestCasePmLink").mockResolvedValue({ success: true });
	act("executeMcpTool").mockResolvedValue({ success: true, output: {} });
	act("createTestCaseInPmWithClaim").mockResolvedValue({
		success: true,
		externalId: "1075",
		externalUrl: "https://pm.example.com/cards/1075",
		outcome: "created",
	});
});

describe("test-case push link guard", () => {
	it.each(["block", "legacy-other-tool"])(
		"refuses %s before update, link write and execution push",
		async (outcome) => {
			act("discoverPMToolCapabilities").mockResolvedValue({
				...CAPABILITIES,
				detectedType: "azure-devops",
			});
			const externalMcpServerId =
				outcome === "block" ? "server-old" : null;
			act("getTestCasesToSync").mockResolvedValue([
				{
					...caseRow("case-1", "42"),
					externalMcpServerId,
					externalUrl: "https://linear.app/example-org/issue/42",
					currentResult: "PASSED",
				},
			]);
			act("checkTestCasePmLink").mockResolvedValue({
				success: false,
				outcome,
				error: "This item is linked to a ticket in a different PM tool. Use Unlink & re-create.",
			});
			const output = await testCaseSyncWorkflow(input());
			expect(act("checkTestCasePmLink")).toHaveBeenCalledWith(
				expect.objectContaining({
					externalId: "42",
					externalUrl: "https://linear.app/example-org/issue/42",
					externalMcpServerId,
					mcpServerId: "server-1",
					pmTool: "azure-devops",
				}),
			);
			expect(act("executeMcpTool")).not.toHaveBeenCalled();
			expect(act("updateTestCaseExternalRefs")).not.toHaveBeenCalled();
			expect(act("pushTestCaseExecutionToPM")).not.toHaveBeenCalled();
			expect(act("recordPmSyncFailure")).not.toHaveBeenCalled();
			expect(output).toMatchObject({
				success: false,
				failedCount: 1,
				syncedCount: 0,
				results: [
					{
						outcome: "failed",
						error: expect.stringContaining("Unlink & re-create"),
					},
				],
			});
		},
	);

	it("checks an active-server link and preserves its update and execution push", async () => {
		act("discoverPMToolCapabilities").mockResolvedValue({
			...CAPABILITIES,
			detectedType: "azure-devops",
		});
		act("getTestCasesToSync").mockResolvedValue([
			{
				...caseRow("case-1", "42"),
				externalMcpServerId: "server-1",
				currentResult: "PASSED",
			},
		]);
		const output = await testCaseSyncWorkflow(
			input({ pmSyncAttemptId: "attempt-A" }),
		);
		expect(act("checkTestCasePmLink")).toHaveBeenCalledWith(
			expect.objectContaining({
				externalMcpServerId: "server-1",
				pmSyncAttemptId: "attempt-A",
			}),
		);
		expect(act("executeMcpTool")).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "update_card",
				args: expect.objectContaining({ card_id: "42" }),
			}),
		);
		expect(act("pushTestCaseExecutionToPM")).toHaveBeenCalledWith(
			expect.objectContaining({ externalId: "42" }),
		);
		expect(output).toMatchObject({ success: true, syncedCount: 1 });
	});

	it("does not restamp a changed-link result already settled by the guard", async () => {
		act("getTestCasesToSync").mockResolvedValue([
			{ ...caseRow("case-1", "42"), externalMcpServerId: "server-old" },
		]);
		act("checkTestCasePmLink").mockResolvedValue({
			success: false,
			outcome: "link-changed",
			error: "This test case's PM link changed. Sync again.",
		});
		const output = await testCaseSyncWorkflow(input());
		expect(output).toMatchObject({
			failedCount: 1,
			results: [
				{
					outcome: "failed",
					error: expect.stringContaining("link changed"),
				},
			],
		});
		expect(act("recordPmSyncFailure")).not.toHaveBeenCalled();
	});

	it.each([
		"database unavailable",
		"The PM configuration is no longer available.",
	])(
		"settles a thrown guard error through the attempt-fenced FAILED path: %s",
		async (error) => {
			act("getTestCasesToSync").mockResolvedValue([
				{
					...caseRow("case-1", "42"),
					externalMcpServerId: "server-old",
				},
			]);
			act("checkTestCasePmLink").mockRejectedValue(new Error(error));
			const output = await testCaseSyncWorkflow(
				input({ pmSyncAttemptId: "attempt-A" }),
			);
			expect(act("recordPmSyncFailure")).toHaveBeenCalledWith(
				expect.objectContaining({
					itemId: "case-1",
					itemType: "testCase",
					onlyIfAttempt: "attempt-A",
					errorMessage: error,
				}),
			);
			expect(output).toMatchObject({
				success: false,
				failedCount: 1,
				results: [{ outcome: "failed", error }],
			});
			expect(act("executeMcpTool")).not.toHaveBeenCalled();
			expect(act("pushTestCaseExecutionToPM")).not.toHaveBeenCalled();
		},
	);

	it("preserves previous activity commands when the patch is absent", async () => {
		h.patched.mockImplementation((id) => id !== PATCH);
		act("getTestCasesToSync").mockResolvedValue([
			{ ...caseRow("case-1", "42"), externalMcpServerId: "server-old" },
		]);
		const output = await testCaseSyncWorkflow(input());
		expect(act("checkTestCasePmLink")).not.toHaveBeenCalled();
		expect(act("executeMcpTool")).toHaveBeenCalledWith(
			expect.objectContaining({ toolName: "update_card" }),
		);
		expect(output.syncedCount).toBe(1);
	});
});
