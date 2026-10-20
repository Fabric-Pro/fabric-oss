/**
 * `testCaseSyncWorkflow` hands a single-case retry's attempt id to every
 * status write it makes for that case (the drift guard's CONFLICT, the
 * SUCCESS with the link, the FAILED), so a late write from an older retry's
 * run cannot overwrite a newer retry's PENDING. A batch run, or a run with no
 * attempt id, writes as before.
 *
 * The workflow body runs with stubbed activities.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	acts: {} as Record<string, ReturnType<typeof vi.fn>>,
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
		patched: () => true,
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

function caseRow(id: string) {
	return {
		id,
		identifier: `TC-${id}`,
		title: "Login works",
		description: null,
		state: "READY",
		priority: "MEDIUM",
		tags: [],
		externalId: `PM-${id}`,
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
		userId: "u-1",
		organizationId: "org-1",
		testCaseIds: ["case-1"],
		direction: "push" as const,
		unsyncedOnly: false,
		...overrides,
	};
}

/** The stubbed activity's calls, created on first use. */
function act(name: string): ReturnType<typeof vi.fn> {
	h.acts[name] ??= vi.fn(async () => undefined);
	return h.acts[name];
}

beforeEach(() => {
	// The workflow module captured these stubs at import: reset, never replace.
	for (const stub of Object.values(h.acts)) {
		stub.mockReset();
		stub.mockResolvedValue(undefined);
	}
	act("discoverPMToolCapabilities").mockResolvedValue(CAPABILITIES);
	act("getTestCasesToSync").mockResolvedValue([caseRow("case-1")]);
	act("detectAndStampPmPushConflict").mockResolvedValue({
		hasConflict: false,
	});
	act("checkTestCasePmLink").mockResolvedValue({ success: true });
	act("executeMcpTool").mockResolvedValue({ success: true, output: {} });
});

describe("testCaseSyncWorkflow attempt hand-off", () => {
	it("a single-case retry scopes the drift guard and SUCCESS writes to its attempt", async () => {
		await testCaseSyncWorkflow(input({ pmSyncAttemptId: "attempt-A" }));

		expect(act("detectAndStampPmPushConflict")).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: "case-1",
				pmSyncAttemptId: "attempt-A",
			}),
		);
		expect(act("updateTestCaseExternalRefs")).toHaveBeenCalledWith(
			expect.objectContaining({
				testCaseId: "case-1",
				pmSyncAttemptId: "attempt-A",
			}),
		);
	});

	it("a single-case retry scopes the FAILED write to its attempt", async () => {
		act("executeMcpTool").mockResolvedValue({
			success: false,
			output: { error: "PM tool rejected the update" },
		});

		await testCaseSyncWorkflow(input({ pmSyncAttemptId: "attempt-A" }));

		expect(act("recordPmSyncFailure")).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: "case-1",
				onlyIfAttempt: "attempt-A",
			}),
		);
	});

	it("a batch run does not apply the attempt to any case", async () => {
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

		for (const [arg] of act("updateTestCaseExternalRefs").mock.calls) {
			expect(
				(arg as { pmSyncAttemptId?: string }).pmSyncAttemptId,
			).toBeUndefined();
		}
		expect(act("updateTestCaseExternalRefs")).toHaveBeenCalledTimes(2);
	});
});

it("redacts uncoded database failures in per-case results and the failure-stamp input", async () => {
	act("executeMcpTool").mockRejectedValue(
		Object.assign(new Error("query with server path"), {
			name: "DriverAdapterError",
		}),
	);
	const result = await testCaseSyncWorkflow(input());
	expect(result.results[0]?.error).toBe("database error");
	expect(act("recordPmSyncFailure")).toHaveBeenCalledWith(
		expect.objectContaining({ errorMessage: "database error" }),
	);
});
