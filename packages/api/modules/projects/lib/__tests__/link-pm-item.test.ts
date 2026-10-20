/**
 * `linkPmItem` (Link to existing item): it links the row only after reading
 * the named PM item through the project's connection and finding it, and
 * never treats a failed read as found. Azure DevOps items must be shown to
 * be in the project's Azure DevOps project. The link carries the server
 * stamp the create path writes, so the next push does not judge it another
 * tool's, and the id the row type's create would have stored for the item,
 * read from the fetched item with that create's own extraction (the real
 * extractors run here). The write itself (`applyPmLink`) is covered against
 * Postgres in `packages/database/__tests__/apply-pm-link.integration.test.ts`.
 */
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fixtureTarget,
	mutablePmSettings,
	pmTargetFixtures,
} from "../../../../../utils/test-fixtures/pm-target";

vi.mock(
	"../../../../../temporal/src/activities/pm-integration/record-pm-sync-state",
	() => ({
		recordPmSyncFailure: vi.fn(async () => true),
		writePmSyncSuccessState: vi.fn(),
	}),
);

vi.mock(
	"../../../../../temporal/src/activities/orchestrator/execution/execute-mcp-tool",
	() => ({ executeMcpTool: vi.fn() }),
);

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	mcpConfigFindFirst: vi.fn(),
	mcpServerFindUnique: vi.fn(),
	userStoryFindFirst: vi.fn(),
	testCaseFindFirst: vi.fn(),
	applyPmLink: vi.fn(),
	resolvePmTarget: vi.fn(),
	fetchPMItemsByIds: vi.fn(),
	discoverPMToolCapabilities: vi.fn(),
	getTemporalClient: vi.fn(),
	describePmSyncWorkflow: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		mCPConfig: { findFirst: mocks.mcpConfigFindFirst },
		mCPServer: { findUnique: mocks.mcpServerFindUnique },
		userStory: { findFirst: mocks.userStoryFindFirst },
		testCase: { findFirst: mocks.testCaseFindFirst },
	},
	applyPmLink: mocks.applyPmLink,
	// The database clock, five minutes back (PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS).
	pmCreateClaimRecoveryCutoff: async () => new Date(Date.now() - 5 * 60_000),
	pmCreateClaimRecoverableAt: (claimedAt: Date | null) =>
		claimedAt ? new Date(claimedAt.getTime() + 5 * 60_000) : null,
}));
// The create paths' own id extraction, unmocked (a pure module).
vi.mock("@repo/temporal", async () => {
	const refs = await import(
		"../../../../../temporal/src/activities/pm-integration/created-item-refs"
	);
	return {
		extractCreatedWorkItemRefs: refs.extractCreatedWorkItemRefs,
		readCreatedTestCaseRefs: refs.readCreatedTestCaseRefs,
		getTemporalClient: mocks.getTemporalClient,
	};
});
vi.mock("@repo/temporal/pm-sync-start", () => ({
	describePmSyncWorkflow: mocks.describePmSyncWorkflow,
	testCaseSyncWorkflowId: (projectId: string, testCaseId: string) =>
		`tc-sync-${projectId}-${testCaseId}`,
}));
vi.mock("@repo/temporal/activities", () => ({
	fetchPMItemsByIds: mocks.fetchPMItemsByIds,
	// The mock returns the capabilities (or null for a failed discovery);
	// the adapter gives them the typed result Link reads, passing the
	// arguments through so a test can see `timeoutMs` and `mcpConfigId`.
	discoverPMToolCapabilitiesResult: async (...args: unknown[]) => {
		const capabilities = await mocks.discoverPMToolCapabilities(...args);
		return capabilities
			? { ok: true, capabilities }
			: {
					ok: false,
					error: {
						code: "NO_CAPABILITIES",
						message: "no capabilities",
					},
				};
	},
}));
vi.mock("../resolve-pm-target", () => ({
	resolvePmTarget: mocks.resolvePmTarget,
}));

import { linkPmItem } from "../link-pm-item";

const PROJECT = {
	organizationId: "org-1",
	projectManagementMcpServerId: "srv-project",
	projectManagementMcpConfigId: "cfg-1",
	projectManagementContainerId: "container-guid",
	projectManagementContainerName: "Example Project",
	projectManagementAdditionalContext: { area: "x" },
};
const UNLINKED = {
	identifier: "US-7",
	externalId: null,
	pmCreateClaimId: "claim-read",
	// Older than the recovery bound: clearable.
	pmCreateClaimedAt: new Date(Date.now() - 60 * 60_000),
	lastPmSyncStatus: "FAILED",
	lastPmSyncAttemptId: "attempt-1",
};
const MCP_TARGET = {
	kind: "mcp" as const,
	mcpConfigId: "cfg-1",
	// The resolved config's server: what a story's MCP push compares the
	// stored stamp with. Deliberately not the project's server here.
	mcpConfig: {
		id: "cfg-1",
		enabled: true,
		mcpServerId: "srv-config",
		baseUrl: "https://pm.example.com",
	},
};
const REST_TARGET = { kind: "rest-gitlab" as const, mcpConfigId: null };

function fetched(item: Record<string, unknown> | null, extra = {}) {
	return {
		items: item ? [item] : [],
		total: item ? 1 : 0,
		hasNextPage: false,
		failedIds: [],
		notFoundIds: [],
		...extra,
	};
}

async function refusal(promise: Promise<unknown>) {
	const error = await promise.then(
		() => {
			throw new Error("expected a refusal");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ORPCError);
	const e = error as ORPCError<string, { errorCode?: string }>;
	return { code: e.code, errorCode: e.data?.errorCode, message: e.message };
}

/** A Jira issue as its get returns it: numeric id and key. */
const JIRA_RAW = {
	id: "10001",
	key: "PROJ-12",
	self: "https://pm.example.com/rest/api/3/issue/10001",
	fields: { summary: "Checkout" },
};
const jiraItem = (requested: string) => ({
	id: requested,
	url: "https://pm.example.com/browse/PROJ-12",
	raw: JIRA_RAW,
});

const storyArgs = {
	row: { storyId: "story-1" },
	projectId: "proj-1",
	externalId: "PROJ-12",
	userId: "user-1",
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.projectFindUnique.mockResolvedValue(PROJECT);
	mocks.userStoryFindFirst.mockResolvedValue(UNLINKED);
	mocks.testCaseFindFirst.mockResolvedValue({
		...UNLINKED,
		identifier: "TC-3",
	});
	mocks.resolvePmTarget.mockResolvedValue(MCP_TARGET);
	mocks.discoverPMToolCapabilities.mockResolvedValue({
		detectedType: "jira",
		availableTools: ["getJiraIssue"],
	});
	mocks.fetchPMItemsByIds.mockResolvedValue(fetched(jiraItem("PROJ-12")));
	mocks.applyPmLink.mockResolvedValue({ status: "linked" });
	mocks.getTemporalClient.mockResolvedValue({ workflow: {} });
	mocks.describePmSyncWorkflow.mockResolvedValue("not-found");
});

describe("refusals before the PM tool is read", () => {
	it("refuses a row not in the project", async () => {
		mocks.userStoryFindFirst.mockResolvedValue(null);

		expect(await refusal(linkPmItem(storyArgs))).toMatchObject({
			code: "NOT_FOUND",
			errorCode: "PM_LINK_ROW_NOT_FOUND",
		});
		expect(mocks.userStoryFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "story-1",
					projectId: "proj-1",
					project: { organizationId: "org-1" },
				},
			}),
		);
		expect(mocks.fetchPMItemsByIds).not.toHaveBeenCalled();
	});

	it("reads a test case only while it is not soft-deleted", async () => {
		mocks.testCaseFindFirst.mockResolvedValue(null);

		expect(
			await refusal(
				linkPmItem({ ...storyArgs, row: { testCaseId: "tc-1" } }),
			),
		).toMatchObject({ errorCode: "PM_LINK_ROW_NOT_FOUND" });
		expect(mocks.testCaseFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "tc-1", deletedAt: null }),
			}),
		);
	});

	it("refuses a row that is already linked", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			...UNLINKED,
			externalId: "99",
		});

		expect(await refusal(linkPmItem(storyArgs))).toMatchObject({
			code: "CONFLICT",
			errorCode: "PM_LINK_ALREADY_LINKED",
		});
		expect(mocks.fetchPMItemsByIds).not.toHaveBeenCalled();
	});

	it.each([
		["for an attempt", "attempt-1"],
		["with no attempt id", null],
	])("refuses a row PENDING %s", async (_label, attemptId) => {
		mocks.userStoryFindFirst.mockResolvedValue({
			...UNLINKED,
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: attemptId,
		});

		expect(await refusal(linkPmItem(storyArgs))).toMatchObject({
			code: "CONFLICT",
			errorCode: "PM_LINK_SYNC_PENDING",
		});
		expect(mocks.fetchPMItemsByIds).not.toHaveBeenCalled();
		expect(mocks.applyPmLink).not.toHaveBeenCalled();
	});

	it.each([
		["younger than the recovery bound", new Date(Date.now() - 60_000)],
		["with no timestamp", null],
	])(
		"refuses a held claim %s, before reading the PM tool",
		async (_label, claimedAt) => {
			mocks.userStoryFindFirst.mockResolvedValue({
				...UNLINKED,
				pmCreateClaimedAt: claimedAt,
			});

			const error = await linkPmItem(storyArgs).catch((e: unknown) => e);

			expect(error).toBeInstanceOf(ORPCError);
			const e = error as ORPCError<
				string,
				{ errorCode?: string; recoverableAt?: string | null }
			>;
			expect(e.code).toBe("CONFLICT");
			expect(e.data?.errorCode).toBe("PM_RECOVERY_TOO_RECENT");
			expect(e.message).toContain(
				"A push may still be creating this item",
			);
			expect(e.data?.recoverableAt).toBe(
				claimedAt
					? new Date(claimedAt.getTime() + 5 * 60_000).toISOString()
					: null,
			);
			expect(mocks.resolvePmTarget).not.toHaveBeenCalled();
			expect(mocks.fetchPMItemsByIds).not.toHaveBeenCalled();
			expect(mocks.applyPmLink).not.toHaveBeenCalled();
		},
	);

	it("lets an unlinked row with no claim through whatever its age", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			...UNLINKED,
			pmCreateClaimId: null,
			pmCreateClaimedAt: null,
			lastPmSyncStatus: null,
		});

		await expect(linkPmItem(storyArgs)).resolves.toMatchObject({
			linked: true,
		});
	});

	it("refuses when no PM tool resolves for the project", async () => {
		mocks.resolvePmTarget.mockResolvedValue(null);

		expect(await refusal(linkPmItem(storyArgs))).toMatchObject({
			code: "BAD_REQUEST",
			errorCode: "PM_LINK_NO_PM_TOOL",
		});
		expect(mocks.fetchPMItemsByIds).not.toHaveBeenCalled();
		expect(mocks.applyPmLink).not.toHaveBeenCalled();
	});

	it("runs the caller's target gate before reading, and stops when it refuses", async () => {
		const gate = vi
			.fn()
			.mockRejectedValue(
				new ORPCError("BAD_REQUEST", { message: "unsupported" }),
			);

		expect(
			await refusal(
				linkPmItem({ ...storyArgs, assertTargetSupported: gate }),
			),
		).toMatchObject({ message: "unsupported" });
		expect(gate).toHaveBeenCalledWith(MCP_TARGET, "org-1");
		expect(mocks.fetchPMItemsByIds).not.toHaveBeenCalled();
	});
});

describe("verifying the item", () => {
	it("refuses an item the PM tool reports not found", async () => {
		mocks.fetchPMItemsByIds.mockResolvedValue(
			fetched(null, {
				failedIds: ["PROJ-12"],
				notFoundIds: ["PROJ-12"],
			}),
		);

		expect(await refusal(linkPmItem(storyArgs))).toMatchObject({
			code: "NOT_FOUND",
			errorCode: "PM_LINK_ITEM_NOT_FOUND",
		});
		expect(mocks.applyPmLink).not.toHaveBeenCalled();
	});

	it("refuses a failed read as unreachable, never as found", async () => {
		mocks.fetchPMItemsByIds.mockResolvedValue(
			fetched(null, {
				failedIds: ["PROJ-12"],
				failedIdErrors: { "PROJ-12": "401 Unauthorized" },
			}),
		);

		const r = await refusal(linkPmItem(storyArgs));

		expect(r).toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			errorCode: "PM_LINK_PM_UNREACHABLE",
		});
		expect(r.message).toContain("401 Unauthorized");
		expect(mocks.applyPmLink).not.toHaveBeenCalled();
	});

	it("refuses an item the read also lists as failed", async () => {
		mocks.fetchPMItemsByIds.mockResolvedValue(
			fetched(
				{ id: "PROJ-12", url: null, raw: {} },
				{ failedIds: ["PROJ-12"] },
			),
		);

		expect(await refusal(linkPmItem(storyArgs))).toMatchObject({
			errorCode: "PM_LINK_PM_UNREACHABLE",
		});
		expect(mocks.applyPmLink).not.toHaveBeenCalled();
	});

	it("refuses when the read returns no item and no failure", async () => {
		mocks.fetchPMItemsByIds.mockResolvedValue(fetched(null));

		expect(await refusal(linkPmItem(storyArgs))).toMatchObject({
			errorCode: "PM_LINK_PM_UNREACHABLE",
		});
		expect(mocks.applyPmLink).not.toHaveBeenCalled();
	});

	it("does not take another item the read returned for this id", async () => {
		mocks.fetchPMItemsByIds.mockResolvedValue(
			fetched({ id: "PROJ-13", url: null, raw: JIRA_RAW }),
		);

		expect(await refusal(linkPmItem(storyArgs))).toMatchObject({
			errorCode: "PM_LINK_PM_UNREACHABLE",
		});
		expect(mocks.applyPmLink).not.toHaveBeenCalled();
	});

	it("refuses when the read throws", async () => {
		mocks.fetchPMItemsByIds.mockRejectedValue(new Error("socket hang up"));

		const r = await refusal(linkPmItem(storyArgs));

		expect(r.errorCode).toBe("PM_LINK_PM_UNREACHABLE");
		expect(r.message).toContain("socket hang up");
		expect(mocks.applyPmLink).not.toHaveBeenCalled();
	});

	it("refuses when tool discovery fails (it cannot tell Azure DevOps apart)", async () => {
		mocks.discoverPMToolCapabilities.mockResolvedValue(null);

		expect(await refusal(linkPmItem(storyArgs))).toMatchObject({
			errorCode: "PM_LINK_PM_UNREACHABLE",
		});
		expect(mocks.fetchPMItemsByIds).not.toHaveBeenCalled();
	});

	describe("a discovery that hangs", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it("is cut off at the verify timeout and refuses, passing the project's binding", async () => {
			// Like the real function: never settles unless given a timeout,
			// then reports DISCOVERY_TIMEOUT once it elapses.
			mocks.discoverPMToolCapabilities.mockImplementation(
				(params: { timeoutMs?: number }) =>
					new Promise((resolve) => {
						if (params.timeoutMs !== undefined) {
							setTimeout(() => resolve(null), params.timeoutMs);
						}
					}),
			);
			let outcome: unknown = "pending";
			const settled = refusal(linkPmItem(storyArgs)).then((r) => {
				outcome = r;
			});

			await vi.advanceTimersByTimeAsync(30_000);
			await settled;

			expect(outcome).toMatchObject({
				code: "SERVICE_UNAVAILABLE",
				errorCode: "PM_LINK_PM_UNREACHABLE",
			});
			expect(mocks.discoverPMToolCapabilities).toHaveBeenCalledWith(
				expect.objectContaining({
					timeoutMs: 30_000,
					pmTarget: {
						additionalContext:
							PROJECT.projectManagementAdditionalContext,
					},
				}),
			);
			expect(mocks.fetchPMItemsByIds).not.toHaveBeenCalled();
			expect(mocks.applyPmLink).not.toHaveBeenCalled();
		});
	});
});

describe("Azure DevOps", () => {
	const adoArgs = { ...storyArgs, externalId: "1234" };
	const adoItem = (fields: Record<string, unknown> | undefined) => ({
		id: "1234",
		url: "https://dev.azure.com/example/_workitems/edit/1234",
		raw: fields ? { id: 1234, fields } : { id: 1234 },
	});

	beforeEach(() => {
		mocks.discoverPMToolCapabilities.mockResolvedValue({
			detectedType: "azure-devops",
			availableTools: ["wit_get_work_item"],
		});
	});

	it("reads under the project name and links an item in the project's Azure DevOps project", async () => {
		mocks.fetchPMItemsByIds.mockResolvedValue(
			fetched(adoItem({ "System.TeamProject": "Example Project" })),
		);

		await expect(linkPmItem(adoArgs)).resolves.toMatchObject({
			linked: true,
			externalId: "1234",
		});
		expect(mocks.fetchPMItemsByIds).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpConfigId: "cfg-1",
				containerId: "Example Project",
				externalIds: ["1234"],
			}),
		);
	});

	it("refuses an item in another Azure DevOps project", async () => {
		mocks.fetchPMItemsByIds.mockResolvedValue(
			fetched(adoItem({ "System.TeamProject": "Other Project" })),
		);

		expect(await refusal(linkPmItem(adoArgs))).toMatchObject({
			code: "BAD_REQUEST",
			errorCode: "PM_LINK_WRONG_PROJECT",
		});
		expect(mocks.applyPmLink).not.toHaveBeenCalled();
	});

	it("refuses an item whose project field is absent", async () => {
		mocks.fetchPMItemsByIds.mockResolvedValue(
			fetched(adoItem({ "System.Title": "x" })),
		);

		expect(await refusal(linkPmItem(adoArgs))).toMatchObject({
			errorCode: "PM_LINK_PROJECT_UNVERIFIED",
		});
		expect(mocks.applyPmLink).not.toHaveBeenCalled();
	});

	it("refuses when the project has no Azure DevOps project name to compare with", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			...PROJECT,
			projectManagementContainerName: null,
		});
		mocks.fetchPMItemsByIds.mockResolvedValue(
			fetched(adoItem({ "System.TeamProject": "container-guid" })),
		);

		expect(await refusal(linkPmItem(adoArgs))).toMatchObject({
			errorCode: "PM_LINK_PROJECT_UNVERIFIED",
		});
		expect(mocks.applyPmLink).not.toHaveBeenCalled();
	});

	it("refuses an id that is not the plain number the create path stores", async () => {
		for (const externalId of ["#1234", "01234", "1e3", "abc"]) {
			expect(
				await refusal(linkPmItem({ ...adoArgs, externalId })),
			).toMatchObject({ errorCode: "PM_LINK_INVALID_ID" });
		}
		expect(mocks.fetchPMItemsByIds).not.toHaveBeenCalled();
	});
});

describe("a push of the test case running", () => {
	const tcArgs = { ...storyArgs, row: { testCaseId: "tc-1" } };

	it("refuses while the case's sync workflow is running, right before the write", async () => {
		mocks.describePmSyncWorkflow.mockResolvedValue("running");

		expect(await refusal(linkPmItem(tcArgs))).toMatchObject({
			code: "CONFLICT",
			errorCode: "PM_LINK_SYNC_PENDING",
		});
		expect(mocks.describePmSyncWorkflow).toHaveBeenCalledWith(
			{ workflow: {} },
			"tc-sync-proj-1-tc-1",
		);
		// Checked after the item was read, immediately before the write.
		expect(mocks.fetchPMItemsByIds).toHaveBeenCalled();
		expect(mocks.applyPmLink).not.toHaveBeenCalled();
	});

	it("refuses when Temporal cannot say whether one runs", async () => {
		mocks.describePmSyncWorkflow.mockResolvedValue("unknown");
		expect(await refusal(linkPmItem(tcArgs))).toMatchObject({
			errorCode: "PM_LINK_SYNC_UNVERIFIED",
		});

		mocks.getTemporalClient.mockRejectedValue(new Error("no connection"));
		expect(await refusal(linkPmItem(tcArgs))).toMatchObject({
			errorCode: "PM_LINK_SYNC_UNVERIFIED",
		});
		expect(mocks.applyPmLink).not.toHaveBeenCalled();
	});

	it.each(["closed", "not-found"])(
		"links when the workflow is %s",
		async (state) => {
			mocks.describePmSyncWorkflow.mockResolvedValue(state);
			await expect(linkPmItem(tcArgs)).resolves.toMatchObject({
				linked: true,
			});
		},
	);

	it("does not describe a workflow for a story (no stable id)", async () => {
		await linkPmItem(storyArgs);
		expect(mocks.describePmSyncWorkflow).not.toHaveBeenCalled();
	});
});

describe("the link written", () => {
	it("MCP story: stores the story create's id form, stamps the resolved config's server and passes the claim read", async () => {
		const result = await linkPmItem(storyArgs);

		// The story create stores Jira's numeric id (COMMON_ID_FIELDS puts
		// `id` ahead of `key`), whatever the user typed.
		expect(result).toEqual({
			linked: true,
			externalId: "10001",
			externalUrl: "https://pm.example.com/browse/PROJ-12",
		});
		expect(mocks.applyPmLink).toHaveBeenCalledWith({
			storyId: "story-1",
			projectId: "proj-1",
			expectedPmCreateClaimId: "claim-read",
			externalId: "10001",
			externalUrl: "https://pm.example.com/browse/PROJ-12",
			externalMcpServerId: "srv-config",
			externalPmTarget: 'pmt1:["srv-config","","container-guid"]',
		});
		expect(mocks.fetchPMItemsByIds).toHaveBeenCalledWith(
			expect.objectContaining({
				containerId: "container-guid",
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
	});

	it("MCP test case: stores the test-case create's id form and stamps the project's server", async () => {
		mocks.fetchPMItemsByIds.mockResolvedValue(fetched(jiraItem("10001")));
		await linkPmItem({
			...storyArgs,
			row: { testCaseId: "tc-1" },
			externalId: "10001",
		});

		// The test-case create stores Jira's key ahead of its numeric id.
		expect(mocks.applyPmLink).toHaveBeenCalledWith(
			expect.objectContaining({
				testCaseId: "tc-1",
				externalId: "PROJ-12",
				externalMcpServerId: "srv-project",
			}),
		);
	});

	it.each([
		["story", { storyId: "story-1" }, "10001"],
		["test case", { testCaseId: "tc-1" }, "PROJ-12"],
	] as const)(
		"%s: both spellings of one Jira issue store one id",
		async (_label, row, stored) => {
			for (const typed of ["PROJ-12", "10001"]) {
				mocks.fetchPMItemsByIds.mockResolvedValue(
					fetched(jiraItem(typed)),
				);
				await linkPmItem({ ...storyArgs, row, externalId: typed });
			}

			expect(mocks.applyPmLink).toHaveBeenCalledTimes(2);
			for (const call of mocks.applyPmLink.mock.calls) {
				expect(call[0].externalId).toBe(stored);
			}
		},
	);

	it("story: reads the id with the update tool's id parameter first, as the create does", async () => {
		mocks.discoverPMToolCapabilities.mockResolvedValue({
			detectedType: "jira",
			availableTools: ["getJiraIssue"],
			taskUpdate: { idParam: "key" },
		});
		mocks.fetchPMItemsByIds.mockResolvedValue(fetched(jiraItem("10001")));

		await linkPmItem({ ...storyArgs, externalId: "10001" });

		expect(mocks.applyPmLink).toHaveBeenCalledWith(
			expect.objectContaining({ externalId: "PROJ-12" }),
		);
	});

	it("refuses an item whose id it cannot read, never storing the typed text", async () => {
		mocks.fetchPMItemsByIds.mockResolvedValue(
			fetched({ id: "PROJ-12", url: null, raw: { fields: {} } }),
		);

		expect(await refusal(linkPmItem(storyArgs))).toMatchObject({
			errorCode: "PM_LINK_ID_UNREADABLE",
		});
		expect(
			await refusal(
				linkPmItem({ ...storyArgs, row: { testCaseId: "tc-1" } }),
			),
		).toMatchObject({ errorCode: "PM_LINK_ID_UNREADABLE" });
		expect(mocks.applyPmLink).not.toHaveBeenCalled();
	});

	describe("a malformed id in the PM tool's answer", () => {
		const MALFORMED: [string, unknown][] = [
			["null", null],
			["an object", {}],
			["NaN", Number.NaN],
			["an array", ["wrong"]],
			["an empty string", ""],
		];

		it.each(MALFORMED)(
			"story: %s ahead of a valid id field is skipped, and the valid id stored",
			async (_label, value) => {
				mocks.fetchPMItemsByIds.mockResolvedValue(
					fetched({
						id: "PROJ-12",
						url: "https://pm.example.com/browse/PROJ-12",
						raw: { number: value, key: "PROJ-12", fields: {} },
					}),
				);

				await linkPmItem(storyArgs);

				expect(mocks.applyPmLink).toHaveBeenCalledWith(
					expect.objectContaining({ externalId: "PROJ-12" }),
				);
			},
		);

		it.each(MALFORMED)(
			"story: %s in the update tool's id field falls back to the common fields",
			async (_label, value) => {
				mocks.discoverPMToolCapabilities.mockResolvedValue({
					detectedType: "jira",
					availableTools: ["getJiraIssue"],
					taskUpdate: { idParam: "issueIdOrKey" },
				});
				mocks.fetchPMItemsByIds.mockResolvedValue(
					fetched({
						id: "PROJ-12",
						url: "https://pm.example.com/browse/PROJ-12",
						raw: { issueIdOrKey: value, id: "10001", fields: {} },
					}),
				);

				await linkPmItem(storyArgs);

				expect(mocks.applyPmLink).toHaveBeenCalledWith(
					expect.objectContaining({ externalId: "10001" }),
				);
			},
		);

		it.each(MALFORMED)(
			"%s as the only id is refused as unreadable, for a story and a test case",
			async (_label, value) => {
				mocks.fetchPMItemsByIds.mockResolvedValue(
					fetched({
						id: "PROJ-12",
						url: null,
						raw: { id: value, key: value, fields: {} },
					}),
				);

				expect(await refusal(linkPmItem(storyArgs))).toMatchObject({
					errorCode: "PM_LINK_ID_UNREADABLE",
				});
				expect(
					await refusal(
						linkPmItem({
							...storyArgs,
							row: { testCaseId: "tc-1" },
						}),
					),
				).toMatchObject({ errorCode: "PM_LINK_ID_UNREADABLE" });
				expect(mocks.applyPmLink).not.toHaveBeenCalled();
			},
		);
	});

	describe("the id about to be written fits the tool's stored-id form", () => {
		it("Azure DevOps: an id read from the item that is not a positive integer is refused", async () => {
			mocks.discoverPMToolCapabilities.mockResolvedValue({
				detectedType: "azure-devops",
				availableTools: ["wit_get_work_item"],
			});
			for (const id of [1234.5, -4, 0, "12a"]) {
				mocks.fetchPMItemsByIds.mockResolvedValue(
					fetched({
						id: "1234",
						url: "https://dev.azure.com/example/_workitems/edit/1234",
						raw: {
							id,
							fields: { "System.TeamProject": "Example Project" },
						},
					}),
				);
				expect(
					await refusal(
						linkPmItem({ ...storyArgs, externalId: "1234" }),
					),
				).toMatchObject({ errorCode: "PM_LINK_ID_UNREADABLE" });
			}
			expect(mocks.applyPmLink).not.toHaveBeenCalled();
		});

		it("other tools: an id with whitespace, or longer than 255 characters, is refused; 255 is stored", async () => {
			// (Surrounding whitespace is trimmed before the check.)
			for (const key of ["PROJ 12", "PROJ\t12", "x".repeat(256)]) {
				mocks.fetchPMItemsByIds.mockResolvedValue(
					fetched({
						id: "PROJ-12",
						url: null,
						raw: { key, fields: {} },
					}),
				);
				expect(
					await refusal(
						linkPmItem({
							...storyArgs,
							row: { testCaseId: "tc-1" },
						}),
					),
				).toMatchObject({ errorCode: "PM_LINK_ID_UNREADABLE" });
			}
			expect(mocks.applyPmLink).not.toHaveBeenCalled();

			const longest = "x".repeat(255);
			mocks.fetchPMItemsByIds.mockResolvedValue(
				fetched({ id: "PROJ-12", url: null, raw: { key: longest } }),
			);
			await linkPmItem({ ...storyArgs, row: { testCaseId: "tc-1" } });
			expect(mocks.applyPmLink).toHaveBeenCalledWith(
				expect.objectContaining({ externalId: longest }),
			);
		});
	});

	it("GitLab REST story: reads through the REST path and stamps the project's server", async () => {
		mocks.resolvePmTarget.mockResolvedValue(REST_TARGET);
		mocks.fetchPMItemsByIds.mockResolvedValue(
			fetched({
				id: "42",
				url: "https://gitlab.example.com/group/proj/-/issues/42",
				raw: {},
			}),
		);

		const result = await linkPmItem({ ...storyArgs, externalId: "42" });

		expect(result.externalId).toBe("42");
		expect(mocks.discoverPMToolCapabilities).not.toHaveBeenCalled();
		expect(mocks.fetchPMItemsByIds).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpConfigId: null,
				mcpServerId: "srv-project",
				containerId: "container-guid",
				externalIds: ["42"],
			}),
		);
		expect(mocks.applyPmLink).toHaveBeenCalledWith(
			expect.objectContaining({
				storyId: "story-1",
				externalId: "42",
				externalMcpServerId: "srv-project",
			}),
		);
	});

	it("GitLab REST: refuses an id that is not an issue number", async () => {
		mocks.resolvePmTarget.mockResolvedValue(REST_TARGET);

		expect(
			await refusal(linkPmItem({ ...storyArgs, externalId: "#42" })),
		).toMatchObject({ errorCode: "PM_LINK_INVALID_ID" });
		expect(mocks.fetchPMItemsByIds).not.toHaveBeenCalled();
	});

	it("takes the URL the create would read when the item has none, else stores none", async () => {
		mocks.fetchPMItemsByIds.mockResolvedValue(
			fetched({
				id: "PROJ-12",
				url: null,
				raw: {
					...JIRA_RAW,
					_links: { web: { href: "https://pm.example.com/i/10001" } },
				},
			}),
		);
		await linkPmItem({ ...storyArgs, row: { testCaseId: "tc-1" } });
		expect(mocks.applyPmLink).toHaveBeenLastCalledWith(
			expect.objectContaining({
				externalUrl: "https://pm.example.com/i/10001",
			}),
		);

		mocks.fetchPMItemsByIds.mockResolvedValue(
			fetched({ id: "PROJ-12", url: null, raw: { key: "PROJ-12" } }),
		);
		await linkPmItem({ ...storyArgs, row: { testCaseId: "tc-1" } });
		expect(mocks.applyPmLink).toHaveBeenLastCalledWith(
			expect.objectContaining({ externalUrl: null }),
		);
	});

	it("links an unlinked row that holds no claim, fenced on that NULL", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			...UNLINKED,
			pmCreateClaimId: null,
			lastPmSyncStatus: null,
		});

		await linkPmItem(storyArgs);

		expect(mocks.applyPmLink).toHaveBeenCalledWith(
			expect.objectContaining({ expectedPmCreateClaimId: null }),
		);
	});

	it("reports an item already linked to another row, naming it", async () => {
		mocks.applyPmLink.mockResolvedValue({
			status: "taken",
			otherIdentifier: "US-3",
		});

		const r = await refusal(linkPmItem(storyArgs));

		expect(r).toMatchObject({
			code: "CONFLICT",
			errorCode: "PM_LINK_ITEM_TAKEN",
		});
		expect(r.message).toContain("US-3");
	});

	it("reports a write that missed only on the claim's age (judged by the database clock) as too recent, with the time", async () => {
		const recoverableAt = new Date("2026-10-13T12:04:10.000Z");
		mocks.applyPmLink.mockResolvedValue({
			status: "stale",
			reason: "claim-too-recent",
			recoverableAt,
		});

		const error = (await linkPmItem(storyArgs).catch(
			(e: unknown) => e,
		)) as ORPCError<string, { errorCode?: string; recoverableAt?: string }>;

		expect(error.code).toBe("CONFLICT");
		expect(error.data).toEqual({
			errorCode: "PM_RECOVERY_TOO_RECENT",
			recoverableAt: recoverableAt.toISOString(),
		});
		// Rounded up to the minute, so "after" is never early.
		expect(error.message).toBe(
			"A push may still be creating this item in your PM tool. Try again after 12:05 UTC.",
		);
	});

	it.each([
		["linked", "linked to a PM item after it was loaded"],
		["claim-changed", "pending create changed"],
		["pending", "sync of this item started"],
		["missing", "deleted after it was loaded"],
		["changed", "changed after it was loaded"],
	] as const)(
		"reports a write that matched nothing (%s) as stale",
		async (reason, text) => {
			mocks.applyPmLink.mockResolvedValue({ status: "stale", reason });

			const r = await refusal(linkPmItem(storyArgs));

			expect(r).toMatchObject({
				code: "CONFLICT",
				errorCode: "PM_RECOVERY_STALE",
			});
			expect(r.message).toContain(text);
		},
	);
});

describe("link writer target consistency", () => {
	it.each(pmTargetFixtures)(
		"$name: link-pm-item uses the writer/checker identity",
		async (fixture) => {
			const rest = fixture.name.startsWith("GitLab REST");
			mocks.projectFindUnique.mockResolvedValue({
				...PROJECT,
				projectManagementContainerId: fixture.containerId,
				projectManagementAdditionalContext: {
					...fixture.additionalContext,
					...mutablePmSettings,
				},
			});
			mocks.resolvePmTarget.mockResolvedValue(
				rest
					? REST_TARGET
					: {
							...MCP_TARGET,
							mcpConfig: {
								...MCP_TARGET.mcpConfig,
								...fixture.config,
							},
						},
			);
			mocks.discoverPMToolCapabilities.mockResolvedValue({
				detectedType: fixture.pmTool,
				availableTools: [],
			});
			mocks.fetchPMItemsByIds.mockResolvedValue(
				fetched({
					id: "42",
					url: "https://pm.example.com/42",
					raw: {
						id: 42,
						iid: 42,
						title: "Example",
						fields: { "System.TeamProject": "Example Project" },
					},
				}),
			);
			await linkPmItem({ ...storyArgs, externalId: "42" });
			const written = mocks.applyPmLink.mock.calls[0]?.[0];
			mocks.userStoryFindFirst.mockResolvedValue(written);
			mocks.testCaseFindFirst.mockResolvedValue(written);
			mocks.mcpConfigFindFirst.mockResolvedValue(fixture.config);
			mocks.mcpServerFindUnique.mockResolvedValue(
				fixture.config.mcpServer,
			);
			const { checkStoryPmLink } = await import(
				"../../../../../temporal/src/activities/pm-integration/create-story-in-pm-with-claim"
			);
			const { checkTestCasePmLink } = await import(
				"../../../../../temporal/src/activities/pm-integration/create-test-case-in-pm-with-claim"
			);
			const check = {
				projectId: storyArgs.projectId,
				organizationId: "org-1",
				userId: storyArgs.userId,
				mcpServerId: written.externalMcpServerId,
				mcpConfigId: rest ? null : "cfg-1",
				pmTool: fixture.pmTool,
				toolLabel: fixture.pmTool,
				externalId: written.externalId,
				externalUrl: written.externalUrl,
				externalMcpServerId: written.externalMcpServerId,
				pmTarget: {
					containerId: fixture.containerId,
					additionalContext: fixture.additionalContext,
				},
			};
			await expect(
				checkStoryPmLink({ ...check, storyId: "story-1" }),
			).resolves.toMatchObject({ success: true });
			await expect(
				checkTestCasePmLink({ ...check, testCaseId: "tc-1" }),
			).resolves.toMatchObject({ success: true });

			expect(mocks.applyPmLink).toHaveBeenCalledWith(
				expect.objectContaining({
					externalPmTarget:
						fixture.name === "GitLab REST legacy"
							? expect.toBeOneOf([
									null,
									fixtureTarget(fixture, "srv-project"),
								])
							: fixtureTarget(
									fixture,
									rest ? "srv-project" : "srv-config",
								),
				}),
			);
		},
	);
});
