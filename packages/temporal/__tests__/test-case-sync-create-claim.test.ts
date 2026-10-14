/**
 * `testCaseSyncWorkflow`'s push create under the PM create claim
 * (`patched("test-case-sync-create-claim-v1")`, Fizzy #3045).
 *
 * Patched, an unlinked case is created through `createTestCaseInPmWithClaim`
 * (claim, one send, link and SUCCESS in one transaction), which records its
 * own outcome on the case, so the workflow only counts it: no bare
 * `executeMcpTool` create, no unclaimed `updateTestCaseExternalRefs`, and no
 * second FAILED stamp from the catch. Unpatched (a history recorded before
 * the patch), the previous commands run unchanged.
 *
 * The workflow body runs with stubbed activities. This covers orchestration
 * only; replay compatibility is checked against recorded histories.
 */

import { ActivityFailure, ApplicationFailure } from "@temporalio/workflow";
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

const PATCH = "test-case-sync-create-claim-v1";

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
	act("executeMcpTool").mockResolvedValue({ success: true, output: {} });
	act("createTestCaseInPmWithClaim").mockResolvedValue({
		success: true,
		externalId: "1075",
		externalUrl: "https://pm.example.com/cards/1075",
		outcome: "created",
	});
});

describe("testCaseSyncWorkflow create under the PM create claim", () => {
	it("creates an unlinked case through createTestCaseInPmWithClaim, with the built args, the attempt and the baseline input", async () => {
		const output = await testCaseSyncWorkflow(
			input({ pmSyncAttemptId: "attempt-A" }),
		);

		expect(h.patched).toHaveBeenCalledWith(PATCH);
		expect(act("createTestCaseInPmWithClaim")).toHaveBeenCalledTimes(1);
		expect(act("createTestCaseInPmWithClaim")).toHaveBeenCalledWith({
			testCaseId: "case-1",
			projectId: "project-1",
			organizationId: "org-1",
			userId: "u-1",
			mcpConfigId: "config-1",
			mcpServerId: "server-1",
			pmTarget: { additionalContext: { account_slug: "example-org" } },
			pmTool: "fizzy",
			toolLabel: "fizzy",
			toolName: "create_card",
			createArgs: expect.objectContaining({
				board_id: "board-1",
				title: "Login works",
			}),
			pmSyncAttemptId: "attempt-A",
			baseline: {
				mcpConfigId: "config-1",
				capabilities: CAPABILITIES,
				userId: "u-1",
				organizationId: "org-1",
				containerId: "board-1",
				containerName: undefined,
				additionalContext: { account_slug: "example-org" },
			},
		});
		// Neither the bare create nor the unclaimed link write runs.
		expect(act("executeMcpTool")).not.toHaveBeenCalled();
		expect(act("updateTestCaseExternalRefs")).not.toHaveBeenCalled();
		expect(output).toMatchObject({
			success: true,
			syncedCount: 1,
			failedCount: 0,
			results: [
				{
					testCaseId: "case-1",
					success: true,
					outcome: "synced",
					externalId: "1075",
					externalUrl: "https://pm.example.com/cards/1075",
				},
			],
		});
	});

	it("passes no baseline on the GitLab REST path (no MCP config)", async () => {
		await testCaseSyncWorkflow(input({ mcpConfigId: null }));

		expect(act("createTestCaseInPmWithClaim")).toHaveBeenCalledWith(
			expect.objectContaining({ mcpConfigId: null, baseline: undefined }),
		);
	});

	it.each([
		"claim-held",
		"create-unconfirmed",
		"create-orphan",
		"create-rejected",
		"not-in-project",
	])(
		"an outcome the activity recorded (%s) is counted as failed with its message and not stamped again",
		async (outcome) => {
			act("createTestCaseInPmWithClaim").mockResolvedValue({
				success: false,
				error: "a fizzy item may already exist for it",
				outcome,
			});

			const output = await testCaseSyncWorkflow(input());

			expect(act("recordPmSyncFailure")).not.toHaveBeenCalled();
			expect(output).toMatchObject({
				success: false,
				syncedCount: 0,
				failedCount: 1,
				results: [
					{
						testCaseId: "case-1",
						success: false,
						outcome: "failed",
						error: "a fizzy item may already exist for it",
					},
				],
			});
		},
	);

	it("an activity that fails outright (before any outcome) is stamped FAILED by the catch, for this attempt", async () => {
		act("createTestCaseInPmWithClaim").mockRejectedValue(
			new ActivityFailure(
				"activity failed",
				"createTestCaseInPmWithClaim",
				"1",
				undefined,
				undefined,
				ApplicationFailure.create({ message: "database unreachable" }),
			),
		);

		const output = await testCaseSyncWorkflow(
			input({ pmSyncAttemptId: "attempt-A" }),
		);

		expect(act("recordPmSyncFailure")).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: "case-1",
				errorClass: "push_failed",
				errorMessage: "database unreachable",
				onlyIfAttempt: "attempt-A",
			}),
		);
		expect(output).toMatchObject({ failedCount: 1 });
	});

	it("a batch run passes no attempt to any case's create", async () => {
		act("getTestCasesToSync").mockResolvedValue([
			caseRow("case-1"),
			caseRow("case-2"),
		]);

		await testCaseSyncWorkflow(
			input({
				testCaseIds: ["case-1", "case-2"],
				pmSyncAttemptId: "attempt-A",
			}),
		);

		expect(act("createTestCaseInPmWithClaim")).toHaveBeenCalledTimes(2);
		for (const [arg] of act("createTestCaseInPmWithClaim").mock.calls) {
			expect(
				(arg as { pmSyncAttemptId?: string }).pmSyncAttemptId,
			).toBeUndefined();
		}
	});

	it("a linked case is updated, never created, whichever PM server its link names", async () => {
		act("getTestCasesToSync").mockResolvedValue([
			{ ...caseRow("case-1", "PM-1"), externalMcpServerId: "server-old" },
		]);

		await testCaseSyncWorkflow(input());

		expect(act("createTestCaseInPmWithClaim")).not.toHaveBeenCalled();
		expect(h.patched).not.toHaveBeenCalledWith(PATCH);
		expect(act("executeMcpTool")).toHaveBeenCalledWith(
			expect.objectContaining({ toolName: "update_card" }),
		);
	});

	describe("a history recorded before the patch", () => {
		beforeEach(() => {
			h.patched.mockImplementation((id: string) => id !== PATCH);
		});

		it("runs the previous create and link commands", async () => {
			act("executeMcpTool").mockResolvedValue({
				success: true,
				output: { content: [{ type: "text", text: '{"id":"77"}' }] },
			});

			const output = await testCaseSyncWorkflow(input());

			expect(act("createTestCaseInPmWithClaim")).not.toHaveBeenCalled();
			expect(act("executeMcpTool")).toHaveBeenCalledWith(
				expect.objectContaining({ toolName: "create_card" }),
			);
			expect(act("updateTestCaseExternalRefs")).toHaveBeenCalledWith(
				expect.objectContaining({
					testCaseId: "case-1",
					externalId: "77",
				}),
			);
			expect(output).toMatchObject({ syncedCount: 1 });
		});

		it("still counts a create with no readable id as synced, with no link write, as it did", async () => {
			act("executeMcpTool").mockResolvedValue({
				success: true,
				output: { content: [{ type: "text", text: '{"ok":true}' }] },
			});

			const output = await testCaseSyncWorkflow(input());

			expect(act("updateTestCaseExternalRefs")).not.toHaveBeenCalled();
			expect(output).toMatchObject({ syncedCount: 1, failedCount: 0 });
		});
	});
});
