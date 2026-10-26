/**
 * Focused tests for the Teams `approve-pending-proposal` procedure's NEW
 * PM-sync auto-enqueue behavior. Separate from the integration test so the
 * scope here stays narrow (single concern: PM sync gate + `enqueuePmSync`
 * wiring on the CREATE branch).
 *
 * The bug being fixed: approving a Teams channel-monitor proposal called
 * `createStoryFromProposal` directly in a loop but never enqueued PM sync —
 * so approved proposals landed in Fabric with `pmAutoSyncEnabled=false` and
 * never reached the configured PM tool. The CREATE row appeared as "Unsynced"
 * on the roadmap forever.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROPOSAL_REVIEW_MAX_CHANGES } from "../../backlog/proposal-review";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { handlers, mocks, schemas } = vi.hoisted(() => {
	const schemas: Record<string, import("zod").ZodType> = {};
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		// DB queries
		workflowStart: vi.fn(),
		claim: vi.fn(async () => true),
		getPendingBacklogProposal: vi.fn(),
		markPendingProposalApproved: vi.fn(),
		markPendingProposalApplied: vi.fn(),
		markPendingProposalFailed: vi.fn(),
		appendAppliedChangeIndexes: vi.fn(),
		recordProposalApplication: vi.fn(),
		recordProposalDuplicateResolution: vi.fn(),
		markProposalApplyDispatched: vi.fn(),
		setPendingProposalAttachmentResult: vi.fn(),
		markPendingProposalRejected: vi.fn(),
		projectFindUnique: vi.fn(),
		featureFindFirst: vi.fn(),
		// External services
		createStoryFromProposal: vi.fn(),
		getLinkedTeamsChatGraphId: vi.fn(),
		attachPendingMediaToStory: vi.fn(),
		getMicrosoftAccessToken: vi.fn(),
		uploadFile: vi.fn(),
		// PM sync
		enqueuePmSync: vi.fn(),
		// Loggers
		loggerWarn: vi.fn(),
		loggerInfo: vi.fn(),
		loggerError: vi.fn(),
		loggerDebug: vi.fn(),
	};
	return { handlers, mocks, schemas };
});

vi.mock("@repo/database", () => ({
	getAppliedChangeIndexes: vi.fn(async () => new Set<number>()),
	claimPendingProposalWithReview: mocks.claim,

	getPendingBacklogProposal: mocks.getPendingBacklogProposal,
	markPendingProposalApproved: mocks.markPendingProposalApproved,
	markPendingProposalApplied: mocks.markPendingProposalApplied,
	markPendingProposalFailed: mocks.markPendingProposalFailed,
	appendAppliedChangeIndexes: mocks.appendAppliedChangeIndexes,
	recordProposalApplication: mocks.recordProposalApplication,
	recordProposalDuplicateResolution: mocks.recordProposalDuplicateResolution,
	markProposalApplyDispatched: mocks.markProposalApplyDispatched,
	setPendingProposalAttachmentResult:
		mocks.setPendingProposalAttachmentResult,
	markPendingProposalRejected: mocks.markPendingProposalRejected,
	getLinkedTeamsChatGraphId: mocks.getLinkedTeamsChatGraphId,
	updateStory: vi.fn().mockResolvedValue(undefined),
	db: {
		project: { findUnique: mocks.projectFindUnique },
		feature: { findFirst: mocks.featureFindFirst },
		userStory: { findMany: vi.fn().mockResolvedValue([]) },
	},
	normalizeBacklogTitle: (title: string) =>
		title
			.toLowerCase()
			.trim()
			.replace(/^\[bug\]\s+/i, "")
			.trim(),
	buildBacklogDedupGuard: vi.fn().mockResolvedValue({
		findCollision: () => null,
		recordCreated: () => {},
	}),
	inferDedupFamily: (change: {
		kindOverride?: string | null;
		type: string;
	}) =>
		change.kindOverride === "BUG" || change.type === "bug"
			? "BUG"
			: "FEATURE",
}));

vi.mock("@repo/temporal", async () => ({
	unwrapPmSyncError: (
		await import(
			"../../../../../../temporal/src/workflows/pm-sync-error-unwrap"
		)
	).unwrapPmSyncError,
	createStoryFromProposal: mocks.createStoryFromProposal,
	// Fire-and-forget duplicate detection enqueued after the create loop (flags
	// "Possible duplicate"); stub the trigger so it's a no-op in this test.
	triggerDuplicateDetection: vi.fn(async () => ({
		workflowId: "dup-detect-test",
	})),
	getTemporalClient: vi.fn().mockResolvedValue({
		workflow: { start: mocks.workflowStart },
	}),
}));

vi.mock("@repo/temporal/activities", () => ({
	mapPriority: (v: string | undefined) => v ?? "MEDIUM",
	mapSize: (v: string | undefined) => v ?? "M",
}));

vi.mock("../../../lib/attach-pending-media-to-story", () => ({
	attachPendingMediaToStory: mocks.attachPendingMediaToStory,
	formatAttachmentWarningLines: () => [],
	appendWarningLinesToAttachmentsBlock: (description: string) => description,
}));

vi.mock("@repo/integrations/microsoft", () => ({
	getMicrosoftAccessToken: mocks.getMicrosoftAccessToken,
}));

vi.mock("@repo/storage", () => ({
	uploadFile: mocks.uploadFile,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		info: mocks.loggerInfo,
		error: mocks.loggerError,
		debug: mocks.loggerDebug,
	},
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (input: unknown) => input,
}));

vi.mock("../../../../../orpc/procedures", () => {
	function makeChainable(handlerSlot: string) {
		const chainable: Record<string, unknown> = {};
		Object.assign(chainable, {
			use: () => chainable,
			route: () => chainable,
			input: (schema: import("zod").ZodType) => {
				schemas[handlerSlot] = schema;
				return chainable;
			},
			output: () => chainable,
			handler: (fn: (...args: unknown[]) => unknown) => {
				handlers[handlerSlot] = fn;
				return { _handler: fn };
			},
		});
		return chainable;
	}
	let nextSlot = "approve";
	return {
		get tenantProtectedProcedure() {
			const slot = nextSlot;
			nextSlot = nextSlot === "approve" ? "reject" : slot;
			return makeChainable(slot);
		},
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

// Mock the new enqueue site. The procedure imports from this exact relative
// path, so the mock specifier matches what the source file consumes.
vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mocks.enqueuePmSync,
}));

// Side-effect: register the handler.
import "../approve-pending-proposal";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = "proj-pm-sync-1";
const PROPOSAL_ID = "proposal-pm-sync-1";
const APPROVER_ID = "approver-pm-1";
const PROPOSAL_OWNER_ID = "monitor-owner-pm-1";
const ORG_ID = "org-pm-1";
const PM_CONFIG_ID = "mcp-cfg-fizzy-1";
const PM_CONTAINER_ID = "container-fizzy-1";

const CHANGE_BUG = {
	action: "create" as const,
	type: "bug" as const,
	title: { to: "Cannot upload screenshots" },
	reasoning: "Image upload broken",
	sourceContext: "teams_messages" as const,
};

const CHANGE_FEATURE = {
	action: "create" as const,
	type: "feature" as const,
	title: { to: "Dark mode" },
	reasoning: "Common ask in #design",
	sourceContext: "teams_messages" as const,
};

function makeProposalRow(opts: { changes: (typeof CHANGE_BUG)[] }) {
	return {
		id: PROPOSAL_ID,
		projectId: PROJECT_ID,
		userId: PROPOSAL_OWNER_ID,
		organizationId: ORG_ID,
		status: "PENDING" as const,
		sourceMetadata: {
			channelDisplayName: "general",
			teamId: "T1",
			channelId: "C1",
			threadRootId: "msg-1",
		},
		appliedChangeIndexes: [],
		proposal: { changes: opts.changes },
		summary: opts.changes[0]?.title.to ?? "Sample",
	};
}

const APPROVAL_CTX = {
	user: { id: APPROVER_ID },
	session: { id: "session-pm-1", activeOrganizationId: ORG_ID },
};

beforeEach(() => {
	vi.clearAllMocks();

	mocks.projectFindUnique.mockResolvedValue({
		id: PROJECT_ID,
		organizationId: ORG_ID,
		projectManagementContainerName: "Fizzy Sprint 12",
		projectManagementMcpConfigId: PM_CONFIG_ID,
		projectManagementContainerId: PM_CONTAINER_ID,
	});
	mocks.featureFindFirst.mockResolvedValue(null);
	mocks.appendAppliedChangeIndexes.mockResolvedValue(undefined);
	mocks.markPendingProposalApproved.mockResolvedValue(undefined);
	mocks.markPendingProposalApplied.mockResolvedValue(undefined);
	mocks.markPendingProposalFailed.mockResolvedValue(undefined);

	// Default: the new row is a BUG so `enqueuePmSync` is called with
	// itemType: "bug" (matches the source's `story.kind === "BUG" ? "bug" : "story"`
	// derivation). Tests that need FEATURE override this.
	mocks.createStoryFromProposal.mockImplementation(
		async (params: { title: string }) => ({
			story: {
				id: `story-${params.title.toLowerCase().replace(/\s+/g, "-")}`,
				identifier: "F-100",
				kind: "BUG",
				description: null,
			},
			aiDrafted: false,
		}),
	);
	mocks.attachPendingMediaToStory.mockResolvedValue({
		uploaded: [],
		warnings: [],
	});
	mocks.enqueuePmSync.mockResolvedValue({
		enqueued: true,
		workflowId: "wf-test",
	});
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("approvePendingProposal (Teams) — PM sync auto-enqueue on CREATE", () => {
	it("enqueues PM sync per CREATE when syncToPM=true and PM is configured", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ changes: [CHANGE_BUG] }),
		);

		const result = (await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_BUG],
				syncToPM: true,
				pmConfig: {
					mcpConfigId: PM_CONFIG_ID,
					containerId: PM_CONTAINER_ID,
				},
			},
			context: APPROVAL_CTX,
		})) as { status: string; createdStoryIds: string[] };

		expect(result.status).toBe("applied");
		expect(result.createdStoryIds).toHaveLength(1);
		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				proposalApplicationKey: `proposal:${PROPOSAL_ID}:0`,
			}),
		);

		expect(mocks.recordProposalApplication).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				proposalId: PROPOSAL_ID,
				changeIndex: 0,
				action: "create",
				createdEntityId: result.createdStoryIds[0],
			}),
			{ skipDuplicates: true },
		);

		// `createStoryFromProposal` got the per-row gate so future edits sync.
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		const csfpArg = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			enablePmAutoSync?: boolean;
		};
		expect(csfpArg.enablePmAutoSync).toBe(true);

		// `enqueuePmSync` was called for the new bug row.
		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);
		expect(mocks.enqueuePmSync).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: result.createdStoryIds[0],
				itemType: "bug",
				projectId: PROJECT_ID,
				userId: APPROVER_ID,
				forceInitialPush: true,
				triggerSource: "auto-push",
			}),
		);
	});

	it("derives itemType=story for non-BUG story kinds", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ changes: [CHANGE_FEATURE] }),
		);
		mocks.createStoryFromProposal.mockResolvedValueOnce({
			story: {
				id: "story-dark-mode",
				identifier: "F-200",
				kind: "FEATURE",
				description: null,
			},
			aiDrafted: false,
		});

		await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_FEATURE],
				syncToPM: true,
				pmConfig: {
					mcpConfigId: PM_CONFIG_ID,
					containerId: PM_CONTAINER_ID,
				},
			},
			context: APPROVAL_CTX,
		});

		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);
		const arg = mocks.enqueuePmSync.mock.calls[0]?.[0] as {
			itemType: string;
		};
		expect(arg.itemType).toBe("story");
	});

	it("enqueues PM sync when syncToPM is OMITTED and PM is configured (default-on behavior)", async () => {
		// Regression guard: the headline-bug UI today doesn't pass
		// syncToPM at all. Approvals should still reach the PM tool
		// whenever the project has it wired up.
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ changes: [CHANGE_BUG] }),
		);

		await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_BUG],
				// syncToPM intentionally omitted
			},
			context: APPROVAL_CTX,
		});

		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);
		const csfpArg = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			enablePmAutoSync?: boolean;
		};
		expect(csfpArg.enablePmAutoSync).toBe(true);
	});

	it("does NOT enqueue PM sync when syncToPM=false (explicit opt-out)", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ changes: [CHANGE_BUG] }),
		);

		await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_BUG],
				syncToPM: false,
			},
			context: APPROVAL_CTX,
		});

		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
		// And `enablePmAutoSync` is NOT set on the create call — preserves
		// the legacy default-false on the row.
		const csfpArg = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			enablePmAutoSync?: boolean;
		};
		expect(csfpArg.enablePmAutoSync).toBeUndefined();
	});

	it("does NOT enqueue PM sync when project has no PM configured (even with syncToPM=true)", async () => {
		mocks.projectFindUnique.mockResolvedValueOnce({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			projectManagementContainerName: null,
			projectManagementMcpConfigId: null,
			projectManagementContainerId: null,
		});
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ changes: [CHANGE_BUG] }),
		);

		await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_BUG],
				syncToPM: true,
			},
			context: APPROVAL_CTX,
		});

		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("logs and continues when enqueuePmSync throws — story is still persisted, approval still succeeds", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ changes: [CHANGE_BUG] }),
		);
		mocks.enqueuePmSync.mockRejectedValueOnce(
			new Error("Temporal unreachable"),
		);

		const result = (await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_BUG],
				syncToPM: true,
				pmConfig: {
					mcpConfigId: PM_CONFIG_ID,
					containerId: PM_CONTAINER_ID,
				},
			},
			context: APPROVAL_CTX,
		})) as { status: string; createdStoryIds: string[] };

		expect(result.status).toBe("applied");
		expect(result.createdStoryIds).toHaveLength(1);
		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);

		// The procedure logged a warn for the throw — the source's structured
		// warn carries `errorName: "Error"`.
		const warnedAboutEnqueue = mocks.loggerWarn.mock.calls.some((call) => {
			const meta = call[1] as Record<string, unknown> | undefined;
			return (
				typeof call[0] === "string" &&
				call[0].includes("enqueuePmSync threw") &&
				meta?.storyId === result.createdStoryIds[0]
			);
		});
		expect(warnedAboutEnqueue).toBe(true);
	});
});

describe("approvePendingProposal (Teams) — ROADMAP_RECOMMENDATION refusal", () => {
	it("refuses a roadmap-recommendation batch with BAD_REQUEST and creates nothing", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce({
			...makeProposalRow({ changes: [CHANGE_BUG] }),
			source: "ROADMAP_RECOMMENDATION",
		});

		await expect(
			handlers.approve?.({
				input: {
					projectId: PROJECT_ID,
					organizationId: ORG_ID,
					proposalId: PROPOSAL_ID,
					approvedChanges: [CHANGE_BUG],
				},
				context: APPROVAL_CTX,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});
});

// A Teams chat proposal stores no link of its own (Graph gives chat messages no
// webUrl), so the created work item's "View source" link comes from the deep
// link resolved through the linked chat.
describe("approvePendingProposal (Teams) — source link on the created work item", () => {
	it("stamps a Teams chat proposal's root-message deep link as the story's reporterSourceUrl", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce({
			...makeProposalRow({ changes: [CHANGE_FEATURE] }),
			source: "TEAMS_CHAT",
			sourceMetadata: {
				linkedChatId: "linked-chat-1",
				chatTopic: "Example Action Team",
				chatWebUrl: null,
				threadRootId: "1726000000000",
				threadRootWebLink: null,
			},
		});
		mocks.getLinkedTeamsChatGraphId.mockResolvedValue(
			"19:example-chat@thread.v2",
		);

		await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_FEATURE],
			},
			context: APPROVAL_CTX,
		});

		expect(mocks.getLinkedTeamsChatGraphId).toHaveBeenCalledWith(
			PROJECT_ID,
			"linked-chat-1",
		);
		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				reporterSource: "TEAMS",
				reporterSourceUrl:
					"https://teams.microsoft.com/l/message/19:example-chat@thread.v2/1726000000000?context=%7B%22contextType%22%3A%22chat%22%7D",
			}),
		);
	});

	it.each(["AI_UPDATE_SIDEBAR", "SCOPE_DOCUMENT"])(
		"does not label a %s item as reported via Teams",
		async (source) => {
			mocks.getPendingBacklogProposal.mockResolvedValueOnce({
				...makeProposalRow({ changes: [CHANGE_BUG] }),
				source,
			});

			await handlers.approve?.({
				input: {
					projectId: PROJECT_ID,
					organizationId: ORG_ID,
					proposalId: PROPOSAL_ID,
					approvedChanges: [CHANGE_BUG],
				},
				context: APPROVAL_CTX,
			});

			expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
				expect.objectContaining({ reporterSource: null }),
			);
		},
	);

	it.each(["LOG_MONITOR", "INCIDENT_CLUSTER"])(
		"does not label a %s bug as reported via Teams, and names the scan as its reporter",
		async (source) => {
			mocks.getPendingBacklogProposal.mockResolvedValueOnce({
				...makeProposalRow({ changes: [CHANGE_BUG] }),
				source,
				sourceMetadata: {
					transcript: "Occurrences: 8 in the last 24 hours",
					reporterName: "Fabric recurring-error scan",
				},
			});

			await handlers.approve?.({
				input: {
					projectId: PROJECT_ID,
					organizationId: ORG_ID,
					proposalId: PROPOSAL_ID,
					approvedChanges: [CHANGE_BUG],
				},
				context: APPROVAL_CTX,
			});

			expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
				expect.objectContaining({
					reporterSource: null,
					reporterName: "Fabric recurring-error scan",
				}),
			);
		},
	);

	it("keeps a Teams channel proposal's stored thread link, without a chat lookup", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValueOnce({
			...makeProposalRow({ changes: [CHANGE_FEATURE] }),
			source: "TEAMS_CHANNEL",
			sourceMetadata: {
				channelDisplayName: "general",
				threadRootId: "1726000000000",
				threadRootWebLink:
					"https://teams.example.com/channel/general/1",
			},
		});

		await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_FEATURE],
			},
			context: APPROVAL_CTX,
		});

		expect(mocks.getLinkedTeamsChatGraphId).not.toHaveBeenCalled();
		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				reporterSourceUrl:
					"https://teams.example.com/channel/general/1",
			}),
		);
	});
});

describe("approval failure messages", () => {
	it.each([
		[
			Object.assign(new Error("raw provider auth detail"), {
				name: "ChatGptPlanAuthError",
			}),
			"Your ChatGPT connection needs to be reconnected. Reconnect it, or switch this organization to organization API billing.",
		],
		[
			Object.assign(new Error("raw usage detail"), {
				name: "SubscriptionPlanExhaustedError",
			}),
			"Your ChatGPT plan has no usage left. Wait for its limit to reset, then try again.",
		],
		[
			Object.assign(new Error("Choose another model in settings."), {
				name: "ChatGptPlanModelNotServedError",
			}),
			"Choose another model in settings.",
		],
		[
			Object.assign(new Error("Raise the AI usage limit in settings."), {
				name: "AiUsageLimitExceededError",
			}),
			"Raise the AI usage limit in settings.",
		],

		[
			Object.assign(
				new Error(
					"Invalid `prisma.story.update()` invocation in /app/x.ts: Timed out fetching a new connection from the connection pool",
				),
				{ name: "PrismaClientKnownRequestError", code: "P2024" },
			),
			"database error P2024",
		],
		[new Error("boom"), "boom"],
		[
			new Error("Activity task failed", {
				cause: Object.assign(
					new Error("Connection pool unavailable at /app/x.ts"),
					{ name: "PrismaClientKnownRequestError" },
				),
			}),
			"database error",
		],
		["failure", "Failed to create story from proposal"],
	])(
		"persists and returns safe create failure text for %s",
		async (error, expected) => {
			mocks.getPendingBacklogProposal.mockResolvedValueOnce(
				makeProposalRow({ changes: [CHANGE_BUG] }),
			);
			mocks.createStoryFromProposal.mockRejectedValueOnce(error);
			const log = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				const result = (await handlers.approve?.({
					input: {
						projectId: PROJECT_ID,
						organizationId: ORG_ID,
						proposalId: PROPOSAL_ID,
						approvedChanges: [CHANGE_BUG],
						syncToPM: false,
					},
					context: APPROVAL_CTX,
				})) as { status: string; errors: string[] };
				expect.soft(result.status).toBe("failed");
				expect.soft(result.errors).toEqual([expected]);
				expect
					.soft(mocks.markPendingProposalFailed)
					.toHaveBeenCalledWith(
						PROPOSAL_ID,
						expect.objectContaining({
							errorMessage: expected,
							rawApplyError: expected,
						}),
					);
				expect
					.soft(JSON.stringify(result.errors))
					.not.toContain("prisma.");
				expect
					.soft(log)
					.toHaveBeenCalledWith(
						expect.any(String),
						expect.any(String),
						error,
					);
			} finally {
				log.mockRestore();
			}
		},
	);
});

describe("approval workflow start failure messages", () => {
	it.each([
		[
			Object.assign(
				new Error(
					"Invalid `prisma.story.update()` invocation in /app/x.ts: pool timeout",
				),
				{ name: "PrismaClientKnownRequestError", code: "P2024" },
			),
			"database error P2024",
			"database error",
		],
		[
			new Error("Activity task failed", {
				cause: Object.assign(new Error("Pool timeout at /app/x.ts"), {
					name: "PrismaClientKnownRequestError",
				}),
			}),
			"database error",
			"database error",
		],
		[new Error("boom"), "boom", "boom"],
		["failure", "Failed to start backlog apply workflow", "failure"],
	])(
		"persists and returns safe workflow failure text for %s",
		async (error, expected, classifiedMessage) => {
			const change = {
				...CHANGE_BUG,
				action: "update" as const,
				existingId: "story-1",
			};
			mocks.getPendingBacklogProposal.mockResolvedValueOnce(
				makeProposalRow({
					changes: [change as unknown as typeof CHANGE_BUG],
				}),
			);
			mocks.workflowStart.mockRejectedValueOnce(error);
			const log = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				const result = (await handlers.approve?.({
					input: {
						projectId: PROJECT_ID,
						organizationId: ORG_ID,
						proposalId: PROPOSAL_ID,
						approvedChanges: [change],
						syncToPM: false,
					},
					context: APPROVAL_CTX,
				})) as { status: string; errors: string[] };
				expect.soft(result.status).toBe("failed");
				expect.soft(result.errors).toEqual([expected]);
				expect
					.soft(mocks.markPendingProposalFailed)
					.toHaveBeenCalledWith(
						PROPOSAL_ID,
						expect.objectContaining({
							errorMessage: classifiedMessage,
							rawApplyError: expected,
						}),
					);
				expect
					.soft(log)
					.toHaveBeenCalledWith(
						expect.any(String),
						expect.any(String),
						error,
					);
			} finally {
				log.mockRestore();
			}
		},
	);
});

it("returns earlier created IDs when a later create is refused", async () => {
	const changes = [
		CHANGE_BUG,
		{ ...CHANGE_BUG, title: { to: "Second bug" } },
		{ ...CHANGE_BUG, title: { to: "Third bug" } },
	];
	mocks.getPendingBacklogProposal.mockResolvedValueOnce(
		makeProposalRow({ changes }),
	);
	mocks.createStoryFromProposal
		.mockResolvedValueOnce({
			story: { id: "first-story", identifier: "F-001", kind: "BUG" },
			aiDrafted: true,
		})
		.mockRejectedValueOnce(
			Object.assign(new Error("raw auth detail"), {
				name: "ChatGptPlanAuthError",
			}),
		);
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const result = (await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: changes,
				syncToPM: false,
			},
			context: APPROVAL_CTX,
		})) as { status: string; createdStoryIds: string[] };
		expect(result.status).toBe("failed");
		expect(result.createdStoryIds).toEqual(["first-story"]);
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(2);
	} finally {
		log.mockRestore();
	}
});

describe("approve dispatch clock", () => {
	it("stamps the dispatched workflow after synchronous creates", async () => {
		const update = {
			...CHANGE_BUG,
			action: "update" as const,
			existingId: "example-story",
		};
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({
				changes: [CHANGE_BUG, update as unknown as typeof CHANGE_BUG],
			}),
		);
		mocks.workflowStart.mockImplementationOnce(async (_name, options) => ({
			workflowId: options.workflowId,
		}));
		await handlers.approve({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_BUG, update],
				syncToPM: false,
			},
			context: APPROVAL_CTX,
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		const workflowId = mocks.workflowStart.mock.calls[0][1].workflowId;
		expect(mocks.claim).toHaveBeenCalledWith(
			expect.objectContaining({ applyWorkflowId: workflowId }),
		);
		expect(mocks.markProposalApplyDispatched).toHaveBeenCalledWith({
			proposalId: PROPOSAL_ID,
			applyWorkflowId: workflowId,
			mode: "claimed",
		});
		expect(
			mocks.createStoryFromProposal.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.workflowStart.mock.invocationCallOrder[0]);
		expect(mocks.workflowStart.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.markProposalApplyDispatched.mock.invocationCallOrder[0],
		);
	});
});

describe("stable review identity", () => {
	it("uses the supplied index for an edited create to update override", async () => {
		mocks.getPendingBacklogProposal.mockResolvedValue(
			makeProposalRow({ changes: [CHANGE_BUG, CHANGE_BUG] }),
		);
		const edited = {
			...CHANGE_BUG,
			action: "update",
			existingId: "example-story",
			title: { to: "Edited title" },
		};
		await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				proposalId: PROPOSAL_ID,
				organizationId: ORG_ID,
				approvedChanges: [edited],
				approvedChangeIndexes: [1],
				syncToPM: false,
			},
			context: APPROVAL_CTX,
		});
		expect(mocks.workflowStart.mock.calls[0]?.[1].args[0]).toMatchObject({
			approvedChanges: [edited],
			approvedChangeIndexes: [1],
		});
		expect(mocks.claim.mock.calls[0]?.[0].entries).toMatchObject([
			{ selected: false },
			{ selected: true, change: edited },
		]);
	});
	it.each([[2], [0, 0], []].map((indexes) => ({ indexes })))(
		"rejects invalid indexes %j before effects",
		async ({ indexes }) => {
			mocks.getPendingBacklogProposal.mockResolvedValue(
				makeProposalRow({ changes: [CHANGE_BUG, CHANGE_BUG] }),
			);
			await expect(
				handlers.approve?.({
					input: {
						projectId: PROJECT_ID,
						proposalId: PROPOSAL_ID,
						organizationId: ORG_ID,
						approvedChanges:
							indexes.length === 2
								? [CHANGE_BUG, CHANGE_BUG]
								: [CHANGE_BUG],
						approvedChangeIndexes: indexes,
					},
					context: APPROVAL_CTX,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.claim).not.toHaveBeenCalled();
			expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
			expect(mocks.workflowStart).not.toHaveBeenCalled();
		},
	);
});

it("rejects an approved index above int32 as BAD_REQUEST at the input boundary", async () => {
	const schema = schemas.approve;
	const parsed = schema.safeParse({
		projectId: PROJECT_ID,
		proposalId: PROPOSAL_ID,
		approvedChanges: [CHANGE_BUG],
		approvedChangeIndexes: [2 ** 31 + 1],
	});
	expect(parsed.success).toBe(false);
	const { call, os } = await import("@orpc/server");
	const effect = vi.fn();
	await expect(
		call(os.input(schema).handler(effect), {
			projectId: PROJECT_ID,
			proposalId: PROPOSAL_ID,
			approvedChanges: [CHANGE_BUG],
			approvedChangeIndexes: [2 ** 31 + 1],
		}),
	).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
	expect(effect).not.toHaveBeenCalled();
	expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
});

it("approves a BACKLOG row through the Teams claim", async () => {
	mocks.getPendingBacklogProposal.mockResolvedValue({
		...makeProposalRow({ changes: [CHANGE_BUG] }),
		status: "BACKLOG",
	});
	const result = (await handlers.approve?.({
		input: {
			projectId: PROJECT_ID,
			proposalId: PROPOSAL_ID,
			organizationId: ORG_ID,
			approvedChanges: [CHANGE_BUG],
			syncToPM: false,
		},
		context: APPROVAL_CTX,
	})) as { status: string };
	expect(result.status).toBe("applied");
	expect(mocks.claim).toHaveBeenCalledWith(
		expect.objectContaining({ admitBacklog: true }),
	);
});

it("returns BAD_REQUEST 400 for more than the review cap of approved indexes", async () => {
	const { call, os } = await import("@orpc/server");
	const effect = vi.fn();
	await expect(
		call(os.input(schemas.approve).handler(effect), {
			projectId: PROJECT_ID,
			proposalId: PROPOSAL_ID,
			approvedChanges: [CHANGE_BUG],
			approvedChangeIndexes: Array.from(
				{ length: PROPOSAL_REVIEW_MAX_CHANGES + 1 },
				() => 0,
			),
		}),
	).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
	expect(effect).not.toHaveBeenCalled();
});

it("records a duplicate resolution without an application or PM sync", async () => {
	const { buildBacklogDedupGuard } = await import("@repo/database");
	vi.mocked(buildBacklogDedupGuard).mockResolvedValueOnce({
		findCollision: () => ({
			existingId: "example-existing",
			existingIdentifier: "EX-1",
		}),
		recordCreated: () => {},
	});
	mocks.getPendingBacklogProposal.mockResolvedValueOnce(
		makeProposalRow({ changes: [CHANGE_BUG] }),
	);
	await handlers.approve?.({
		input: {
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			proposalId: PROPOSAL_ID,
			approvedChanges: [CHANGE_BUG],
			syncToPM: true,
		},
		context: APPROVAL_CTX,
	});
	expect(mocks.recordProposalDuplicateResolution).toHaveBeenCalledWith(
		expect.objectContaining({
			proposalId: PROPOSAL_ID,
			changeIndex: 0,
			existingEntityId: "example-existing",
		}),
	);
	expect(mocks.recordProposalApplication).not.toHaveBeenCalled();
	expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	expect(mocks.appendAppliedChangeIndexes).toHaveBeenCalledWith(
		PROPOSAL_ID,
		[0],
	);
});

it.each(["application", "duplicate"])(
	"keeps the approval outcome when %s bookkeeping fails",
	async (kind) => {
		const failure = new Error("Example private change content");
		mocks.getPendingBacklogProposal.mockResolvedValueOnce(
			makeProposalRow({ changes: [CHANGE_BUG] }),
		);
		if (kind === "duplicate") {
			const { buildBacklogDedupGuard } = await import("@repo/database");
			vi.mocked(buildBacklogDedupGuard).mockResolvedValueOnce({
				findCollision: () => ({
					existingId: "example-existing",
					existingIdentifier: "EX-1",
				}),
				recordCreated: () => {},
			});
			mocks.recordProposalDuplicateResolution.mockRejectedValueOnce(
				failure,
			);
		} else {
			mocks.recordProposalApplication.mockRejectedValueOnce(failure);
		}
		const result = (await handlers.approve?.({
			input: {
				projectId: PROJECT_ID,
				organizationId: ORG_ID,
				proposalId: PROPOSAL_ID,
				approvedChanges: [CHANGE_BUG],
				syncToPM: true,
			},
			context: APPROVAL_CTX,
		})) as { status: string; createdStoryIds: string[] };
		expect(result.status).toBe("applied");
		expect(result.createdStoryIds).toHaveLength(
			kind === "application" ? 1 : 0,
		);
		expect(mocks.markPendingProposalFailed).not.toHaveBeenCalled();
		expect(mocks.appendAppliedChangeIndexes).toHaveBeenCalledWith(
			PROPOSAL_ID,
			[0],
		);
		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(
			kind === "application" ? 1 : 0,
		);
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			expect.stringContaining("record"),
			{ proposalId: PROPOSAL_ID, changeIndex: 0 },
		);
		expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain(
			failure.message,
		);
	},
);
