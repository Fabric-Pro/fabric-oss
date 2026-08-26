/**
 * Unit tests for the AI Update story/bug create path in applyBacklogChanges.
 *
 * The bug being fixed: AI Update used to call createStory() directly with no
 * `kind` parameter, so bug-shaped output landed with kind=FEATURE (the DB
 * default). After the fix the activity routes through createStoryFromProposal
 * so the F-171 classifier runs, kind is set correctly, and the bug triage
 * flow (needsMoreInfo, AI analysis, re-evaluation) becomes available.
 *
 * These tests mock the helper itself so they exercise the routing decision
 * (call signature, params, no-prefix title, label, externalId follow-up).
 * The helper's internal classifier behavior is already covered by
 * classify-work-item.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		createStoryFromProposal: vi.fn(),
		createStory: vi.fn(),
		updateStory: vi.fn(),
		tenantWhere: vi.fn(() => ({
			organizationId: "org-1",
			userId: "user-1",
		})),
		dbProjectFindFirst: vi.fn(),
		dbUserStoryFindMany: vi.fn(),
		dbUserStoryFindFirst: vi.fn(),
		generateObject: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		logModelUsageAsync: vi.fn(),
		recordAudit: vi.fn(),
		heartbeat: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	generateObject: mocks.generateObject,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: mocks.logModelUsageAsync,
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: mocks.dbProjectFindFirst },
		userStory: {
			findMany: mocks.dbUserStoryFindMany,
			findFirst: mocks.dbUserStoryFindFirst,
		},
	},
	tenantWhere: mocks.tenantWhere,
	createStory: mocks.createStory,
	updateStory: mocks.updateStory,
	recordAudit: mocks.recordAudit,
	// `normalizeBacklogTitle` is a pure helper that used to live inline in
	// `analyze-context.ts`; it moved to `@repo/database/utils` so the AI
	// Update sidebar guard (here) and the Teams/Slack approve-pending-
	// proposal guards share a single equivalence class. The implementation
	// is mirrored here to keep this test self-contained — if the canonical
	// function ever changes, this mock must follow.
	normalizeBacklogTitle: (title: string) =>
		title
			.toLowerCase()
			.trim()
			.replace(/^\[bug\]\s+/i, "")
			.trim(),
	TERMINAL_DRAFTING_STAGES: ["DECLINED", "CLOSED"],
	isTerminalWorkItemState: (item: {
		draftingStage: string;
		pmAutoHidden: boolean;
	}) =>
		["DECLINED", "CLOSED"].includes(item.draftingStage) ||
		item.pmAutoHidden === true,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: mocks.heartbeat,
}));

vi.mock("../src/lib/create-story-from-proposal", () => ({
	createStoryFromProposal: mocks.createStoryFromProposal,
}));

// Stub the background duplicate-detection enqueue — applyBacklogChanges now
// fire-and-forget starts the detectDuplicates workflow via
// `triggerDuplicateDetection` (its own dedicated unit test). Mocking it here
// keeps this suite hermetic (no Temporal client / @repo/rag / @repo/ai calls).
vi.mock("../src/lib/trigger-duplicate-detection", () => ({
	triggerDuplicateDetection: vi.fn(async () => ({
		workflowId: "dup-detect-test",
	})),
}));

import {
	applyBacklogChanges,
	type ChangeProposal,
} from "../src/activities/backlog-context/analyze-context";

// Use a minimal empty backlog so the activity skips the story fetch.
// `user_story` is the only work-item table — the backlog is a flat list.
const EMPTY_BACKLOG = {
	stories: [],
};

const STORY_SOURCE_AI_UPDATE = "AI_UPDATE" as const;

function makeCreatedStory(
	overrides: Partial<{
		id: string;
		identifier: string;
		title: string;
		kind: "FEATURE" | "BUG";
	}> = {},
) {
	return {
		story: {
			id: overrides.id ?? "story-1",
			identifier: overrides.identifier ?? "F-001",
			title: overrides.title ?? "Persisted title",
			kind: overrides.kind ?? "BUG",
		},
		aiDrafted: false,
	};
}

function makeBugChange(overrides: Record<string, unknown> = {}) {
	return {
		action: "create" as const,
		type: "bug" as const,
		title: { to: "Login button stops working after 2 clicks", from: null },
		description: {
			to: "Repro: click Login twice; second click returns 500.",
			from: null,
		},
		acceptanceCriteria: undefined,
		priority: { to: "P1_HIGH", from: null },
		size: { to: "M", from: null },
		parentFeatureIdentifier: undefined,
		parentFeatureTitle: undefined,
		existingExternalId: undefined,
		reasoning: "test fixture — bug change",
		sourceContext: "test fixture — synthetic",
		...overrides,
	};
}

// A LEGACY story-typed proposal. The analyzer can no longer emit `type:"story"`
// (the generation schema is epic/feature/bug only), but PendingBacklogProposal
// rows stored before the DSU 2026-05-23 retirement still carry it, and the apply
// path must keep processing them (normalizing to the feature leaf at create
// time). The runtime `type` stays "story" to exercise that legacy-input path; the
// return is cast to the now-narrow `ChangeProposal["changes"]` element so it can
// be fed to `applyBacklogChanges`'s public input.
function makeStoryChange(
	overrides: Record<string, unknown> = {},
): ChangeProposal["changes"][number] {
	return {
		action: "create" as const,
		type: "story" as const,
		title: { to: "Add SSO login option", from: null },
		description: {
			to: "PMs want to enable SAML SSO from their identity provider.",
			from: null,
		},
		acceptanceCriteria: undefined,
		priority: { to: "P2_MEDIUM", from: null },
		size: { to: "L", from: null },
		parentFeatureIdentifier: undefined,
		parentFeatureTitle: undefined,
		existingExternalId: undefined,
		reasoning: "test fixture — story change",
		sourceContext: "test fixture — synthetic",
		...overrides,
	} as unknown as ChangeProposal["changes"][number];
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.dbProjectFindFirst.mockResolvedValue({ id: "project-1" });
	mocks.dbUserStoryFindMany.mockResolvedValue([]);
	// Default: existing-row lookup returns nothing, so the apply-time
	// structure-preserving merge is skipped and update bodies are written
	// directly (these tests exercise create/resolution routing, not the merge —
	// which is covered by apply-backlog-changes-structure-merge.test.ts).
	mocks.dbUserStoryFindFirst.mockResolvedValue(null);
	mocks.createStoryFromProposal.mockResolvedValue(makeCreatedStory());
});

describe("applyBacklogChanges → AI Update story/bug create path", () => {
	it("routes a bug-typed change through createStoryFromProposal with kind=BUG hint", async () => {
		const change = makeBugChange();
		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledOnce();
		expect(mocks.createStory).not.toHaveBeenCalled();
		const callArgs = mocks.createStoryFromProposal.mock.calls[0]?.[0];
		expect(callArgs).toMatchObject({
			projectId: "project-1",
			organizationId: "org-1",
			createdById: "user-1",
			title: change.title.to,
			description: change.description.to,
			kind: "BUG",
			labels: ["bug"],
			source: STORY_SOURCE_AI_UPDATE,
			reporterName: null,
			reporterSource: null,
			reporterSourceUrl: null,
			// #1799: skipDrafting is now only set for predrafted items. A
			// non-predrafted bug is unaffected in behavior (bugs always draft to
			// populate needsMoreInfo), but the flag is now honestly false.
			skipDrafting: false,
		});
		expect(result.appliedCount).toBe(1);
		expect(result.createdItems[0]).toMatchObject({
			type: "bug",
			id: "story-1",
			identifier: "F-001",
		});
	});

	it("calls heartbeat for every change in the batch (liveness)", async () => {
		mocks.createStoryFromProposal
			.mockResolvedValueOnce(makeCreatedStory({ kind: "BUG", id: "s-1" }))
			.mockResolvedValueOnce(
				makeCreatedStory({ kind: "FEATURE", id: "s-2" }),
			);

		await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [makeBugChange(), makeStoryChange()],
			existingBacklog: EMPTY_BACKLOG,
		});

		// One heartbeat per iteration of the per-change loop (2 changes).
		// Duplicate detection no longer runs inline here (it's enqueued as a
		// background workflow), so there is no extra detection-phase heartbeat.
		expect(mocks.heartbeat).toHaveBeenCalledTimes(2);
		expect(mocks.heartbeat).toHaveBeenCalledWith(
			expect.objectContaining({
				total: 2,
				type: expect.stringMatching(/^(bug|story)$/),
				action: "create",
			}),
		);
	});

	it("still heartbeats even when the helper throws (per-change error path)", async () => {
		mocks.createStoryFromProposal.mockRejectedValueOnce(
			new Error("classifier exploded"),
		);

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [makeBugChange()],
			existingBacklog: EMPTY_BACKLOG,
		});

		// Heartbeat is BEFORE the try/catch — it must fire even if the
		// per-change work then fails. Liveness must not depend on success.
		expect(mocks.heartbeat).toHaveBeenCalledOnce();
		expect(result.appliedCount).toBe(0);
		expect(result.errors.length).toBeGreaterThanOrEqual(1);
	});

	it("routes a story-typed change through the helper with kind=undefined hint", async () => {
		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({ kind: "FEATURE" }),
		);

		const change = makeStoryChange();
		await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledOnce();
		const callArgs = mocks.createStoryFromProposal.mock.calls[0]?.[0];
		expect(callArgs).toMatchObject({
			title: change.title.to,
			kind: undefined,
			labels: [],
			source: STORY_SOURCE_AI_UPDATE,
		});
	});

	it("persists the title verbatim — does not add a [BUG] prefix", async () => {
		const change = makeBugChange({
			title: { to: "Crash when opening settings", from: null },
		});
		await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog: EMPTY_BACKLOG,
		});

		const callArgs = mocks.createStoryFromProposal.mock.calls[0]?.[0];
		expect(callArgs.title).toBe("Crash when opening settings");
		expect(callArgs.title.startsWith("[BUG]")).toBe(false);
	});

	it("does not pre-strip an existing [BUG] prefix from the AI Update output title", async () => {
		// The current AI Update prompt may still emit [BUG]-prefixed titles
		// (separate cleanup). The persistence layer should not double-prefix
		// or strip — just pass through. Classifier sees the prefix as a signal.
		const change = makeBugChange({
			title: { to: "[BUG] Already-prefixed title", from: null },
		});
		await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog: EMPTY_BACKLOG,
		});

		const callArgs = mocks.createStoryFromProposal.mock.calls[0]?.[0];
		expect(callArgs.title).toBe("[BUG] Already-prefixed title");
	});

	it("respects classifier authority — caller-provided BUG hint that the helper overrides to FEATURE still lands as FEATURE", async () => {
		// We don't simulate the classifier itself here (that's classify-work-item.test.ts);
		// we just verify that the activity uses whatever kind the helper resolves
		// without re-asserting based on change.type.
		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({
				kind: "FEATURE",
				id: "story-2",
				identifier: "F-002",
			}),
		);
		const change = makeBugChange();

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog: EMPTY_BACKLOG,
		});

		// The activity reports change.type back through createdItems
		// (it's the action audit trail of what AI Update asked for, not the
		// classifier's verdict). The persisted kind is what the helper resolved.
		expect(result.createdItems[0]).toMatchObject({
			type: "bug",
			id: "story-2",
			identifier: "F-002",
		});
		expect(mocks.createStoryFromProposal.mock.calls[0]?.[0]).toMatchObject({
			kind: "BUG", // hint passed in
		});
	});

	it("calls updateStory after the helper when existingExternalId is set", async () => {
		const change = makeBugChange({ existingExternalId: "ADO-1234" });
		await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(mocks.updateStory).toHaveBeenCalledOnce();
		expect(mocks.updateStory).toHaveBeenCalledWith("story-1", "project-1", {
			externalId: "ADO-1234",
		});
	});

	it("does not call updateStory when existingExternalId is not set", async () => {
		const change = makeBugChange();
		await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog: EMPTY_BACKLOG,
		});
		expect(mocks.updateStory).not.toHaveBeenCalled();
	});

	it("classifier failure propagates — the helper throws, the activity records an error", async () => {
		mocks.createStoryFromProposal.mockRejectedValueOnce(
			new Error("classifier exploded"),
		);
		const change = makeBugChange();
		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog: EMPTY_BACKLOG,
		});

		// The activity catches per-change errors and accumulates them in `errors`.
		// AC: no thrown error from the activity itself, no silent drop.
		expect(result.appliedCount).toBe(0);
		expect(result.createdItems).toHaveLength(0);
		expect(result.errors.length).toBeGreaterThanOrEqual(1);
		expect(result.errors[0]).toMatchObject({
			error: expect.stringMatching(/classifier exploded/i),
		});
	});

	it("rejects forged projectId via the tenant gatekeeper", async () => {
		mocks.dbProjectFindFirst.mockResolvedValueOnce(null);
		await expect(
			applyBacklogChanges({
				projectId: "forged-project",
				userId: "user-1",
				organizationId: "org-1",
				approvedChanges: [makeBugChange()],
				existingBacklog: EMPTY_BACKLOG,
			}),
		).rejects.toThrow(/not accessible/i);
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("handles a mixed batch — feature + bug in one call", async () => {
		mocks.createStoryFromProposal
			.mockResolvedValueOnce(
				makeCreatedStory({
					kind: "FEATURE",
					id: "s-1",
					identifier: "F-100",
				}),
			)
			.mockResolvedValueOnce(
				makeCreatedStory({
					kind: "BUG",
					id: "s-2",
					identifier: "F-101",
				}),
			);

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [makeStoryChange(), makeBugChange()],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(2);
		expect(result.appliedCount).toBe(2);
		expect(result.createdItems).toHaveLength(2);
		// Both items should be reported with the change.type the activity received.
		const types = result.createdItems.map((i) => i.type).sort();
		expect(types).toEqual(["bug", "story"]);
	});
});

// =============================================================================
// Feature routing: EVERY feature CREATE → roadmap UserStory(kind=FEATURE)
// =============================================================================
//
// Story-retirement (DSU 2026-05-23) made the analyzer emit `type:"feature"` for
// every non-defect, and the Epic/Feature folder tables were subsequently
// dropped — so feature creates ALWAYS materialize as a roadmap-visible
// UserStory(kind=FEATURE) via createStoryFromProposal (same as a manual
// "Feature F-XXX"), for every PM tool including Azure DevOps.

function makeFeatureChange(overrides: Record<string, unknown> = {}) {
	return {
		action: "create" as const,
		type: "feature" as const,
		title: { to: "Export roadmap to CSV", from: null },
		description: {
			to: "Overview: users want CSV export of the roadmap.",
			from: null,
		},
		acceptanceCriteria: {
			to: "**Given** x **When** y **Then** z",
			from: null,
		},
		priority: { to: "P2_MEDIUM", from: null },
		size: { to: "M", from: null },
		parentEpicIdentifier: undefined,
		parentEpicTitle: undefined,
		parentFeatureIdentifier: undefined,
		parentFeatureTitle: undefined,
		existingExternalId: undefined,
		reasoning: "test fixture — feature change",
		sourceContext: "test fixture — synthetic",
		...overrides,
	};
}

describe("applyBacklogChanges → feature routing (always a roadmap UserStory)", () => {
	it("a feature CREATE becomes a roadmap UserStory (createStoryFromProposal kind=FEATURE, skipClassifier) — not a Feature container", async () => {
		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({
				kind: "FEATURE",
				id: "f-1",
				identifier: "F-300",
			}),
		);

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [makeFeatureChange()],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(mocks.createStory).not.toHaveBeenCalled();
		expect(mocks.createStoryFromProposal).toHaveBeenCalledOnce();
		expect(mocks.createStoryFromProposal.mock.calls[0]?.[0]).toMatchObject({
			kind: "FEATURE",
			skipClassifier: true,
			labels: [],
			source: STORY_SOURCE_AI_UPDATE,
			// #1799: a non-predrafted AI-Update Feature now RE-DRAFTS through the
			// Clean Spec prompt (was skipped/verbatim before). skipDrafting is only
			// true for predrafted items now.
			skipDrafting: false,
		});
		expect(result.appliedCount).toBe(1);
		expect(result.createdItems[0]).toMatchObject({
			type: "feature",
			id: "f-1",
		});
		// PM sync resolves items by type — a UserStory leaf must be corrected
		// to "story" so the sync looks in the user_story table.
		expect(result.typeCorrections[0]).toBe("story");
	});

	it("the feature's description + acceptanceCriteria are forwarded verbatim to the UserStory", async () => {
		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({
				kind: "FEATURE",
				id: "f-2",
				identifier: "F-301",
			}),
		);

		await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [
				makeFeatureChange({
					description: { to: "Overview: nice feature.", from: null },
					acceptanceCriteria: {
						to: "**Given** a **Then** b",
						from: null,
					},
				}),
			],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(mocks.createStoryFromProposal.mock.calls[0]?.[0]).toMatchObject({
			description: "Overview: nice feature.",
			acceptanceCriteria: "**Given** a **Then** b",
		});
	});

	it("Azure DevOps projects ALSO produce a roadmap UserStory — the Feature container path was removed", async () => {
		// The folder tables are gone, so there is no per-PM-tool routing left:
		// even an ADO-configured project materializes feature creates as
		// UserStory(kind=FEATURE) with the feature→story PM-sync correction.
		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({
				kind: "FEATURE",
				id: "f-ado",
				identifier: "F-310",
			}),
		);

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [makeFeatureChange()],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledOnce();
		expect(result.createdItems[0]).toMatchObject({
			type: "feature",
			id: "f-ado",
		});
		expect(result.typeCorrections[0]).toBe("story");
	});

	it("an UPDATE-fallback CREATE for an unresolvable feature also becomes a roadmap UserStory (kind=FEATURE, typeCorrection=story)", async () => {
		// An UPDATE whose target can't be resolved (non-Fabric id, no matching
		// identifier/externalId/title) falls back to a CREATE. That second copy
		// of the routing logic must also send flat features to a UserStory.
		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({
				kind: "FEATURE",
				id: "f-fb",
				identifier: "F-400",
			}),
		);
		const change = makeFeatureChange({
			action: "update",
			existingId: "fizzy-card-999", // not a Fabric CUID/UUID
			existingIdentifier: "NONEXISTENT-1", // not in the (empty) backlog
			title: { to: "Realtime presence indicators", from: "Old title" },
		});

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledOnce();
		expect(mocks.createStoryFromProposal.mock.calls[0]?.[0]).toMatchObject({
			kind: "FEATURE",
			skipClassifier: true,
		});
		expect(result.createdItems[0]).toMatchObject({
			type: "feature",
			id: "f-fb",
		});
		expect(result.typeCorrections[0]).toBe("story");
	});
});

// =============================================================================
// Duplicate-creation guard (closes the gap that caused Dave's report)
// =============================================================================
//
// Three independent vectors that previously produced duplicates, all now
// blocked by the title-collision dedup index in applyBacklogChanges. The
// guard normalizes by lowercase + trim + leading "[BUG] " strip, so it
// catches:
//   A. Exact title collision against an existing story
//   B. [BUG]-prefix legacy mismatch (PR #1041 dropped the prefix from new
//      bugs while old rows still carry it)
//   C. Same-batch duplicate (LLM emits the same change twice in one proposal)
//
// A dedup hit is a silent skip — not an error. The proposal is treated as a
// no-op: no DB write, no createdItems entry, no errors entry. A warning is
// logged so the override is auditable.

describe("applyBacklogChanges → duplicate-create guard", () => {
	it("A. CREATE with title matching an existing story is blocked — no duplicate row", async () => {
		const existingBacklog = {
			epics: [],
			features: [],
			stories: [
				{
					id: "existing-story-1",
					identifier: "F-042",
					title: "Login crashes on Safari",
					description: "Original report from last week",
					featureId: null,
					externalId: null,
				},
			],
		};

		const change = makeBugChange({
			title: { to: "Login crashes on Safari", from: null },
		});

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog,
		});

		// Guard fires before the helper is invoked.
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
		// Nothing was created and nothing failed — the proposal was a no-op.
		expect(result.appliedCount).toBe(0);
		expect(result.createdItems).toHaveLength(0);
		expect(result.errors).toHaveLength(0);
	});

	it("B. CREATE without [BUG] prefix is blocked by existing [BUG]-prefixed row (PR #1041 vector)", async () => {
		// Pre-PR-#1041 bug row still carries the "[BUG] " title prefix the
		// old prompt mandated. The analyzer now emits the same title WITHOUT
		// the prefix per PR #1041. normalizeBacklogTitle strips both sides
		// so the collision is recognized.
		const existingBacklog = {
			epics: [],
			features: [],
			stories: [
				{
					id: "legacy-prefixed-bug",
					identifier: "B-007",
					title: "[BUG] Login crashes on Safari",
					description: "Created pre-#1041 with mandatory prefix",
					featureId: null,
					externalId: null,
				},
			],
		};

		const change = makeBugChange({
			// Post-PR-#1041 prompt forbids the prefix → LLM emits bare title.
			title: { to: "Login crashes on Safari", from: null },
		});

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog,
		});

		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
		expect(result.appliedCount).toBe(0);
		expect(result.createdItems).toHaveLength(0);
		expect(result.errors).toHaveLength(0);
	});

	it("C. Two identical CREATEs in the same batch produce only one row", async () => {
		// The first iteration creates the row and registers its title in the
		// in-batch dedup map; the second iteration sees the collision and
		// is skipped. Empty backlog so the only collision source is the
		// in-batch register.
		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({
				id: "first-of-pair",
				identifier: "B-100",
				title: "Desktop notifications for AI activity",
			}),
		);

		const dup = makeBugChange({
			title: { to: "Desktop notifications for AI activity", from: null },
		});

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [dup, dup],
			existingBacklog: EMPTY_BACKLOG,
		});

		// First call goes through, second is deduped.
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		expect(result.appliedCount).toBe(1);
		expect(result.createdItems).toHaveLength(1);
		expect(result.createdItems[0]?.id).toBe("first-of-pair");
		expect(result.errors).toHaveLength(0);
	});

	it("case + whitespace differences are still treated as duplicates", async () => {
		// Sanity check on the normalization: the LLM's title differs from
		// the existing one only by case and whitespace, but they describe
		// the same bug. Guard must catch this.
		const existingBacklog = {
			epics: [],
			features: [],
			stories: [
				{
					id: "existing-1",
					identifier: "B-050",
					title: "Login crashes on Safari",
					description: null,
					featureId: null,
					externalId: null,
				},
			],
		};

		const change = makeBugChange({
			title: { to: "  LOGIN crashes on Safari  ", from: null },
		});

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog,
		});

		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
		expect(result.appliedCount).toBe(0);
	});

	it("PM kindOverride=FEATURE on a bug-typed change passes kind=FEATURE + skipClassifier=true (classifier bypass)", async () => {
		// The classifier-bias safety net: PM overrides the AI's default in the
		// approval UI. We expect the activity to forward the override AND set
		// skipClassifier so createStoryFromProposal doesn't re-classify and
		// undo the choice. Label switches with kind so PM-tool sync sees
		// FEATURE-shaped metadata.
		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({
				kind: "FEATURE",
				id: "s-99",
				identifier: "F-099",
			}),
		);
		const change = makeBugChange({ kindOverride: "FEATURE" });

		await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledOnce();
		const callArgs = mocks.createStoryFromProposal.mock.calls[0]?.[0];
		expect(callArgs).toMatchObject({
			kind: "FEATURE",
			skipClassifier: true,
			labels: [],
		});
	});

	it("PM kindOverride=BUG on a story-typed change passes kind=BUG + skipClassifier=true with bug label", async () => {
		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({ kind: "BUG", id: "s-101", identifier: "B-101" }),
		);
		const change = makeStoryChange({ kindOverride: "BUG" });

		await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledOnce();
		const callArgs = mocks.createStoryFromProposal.mock.calls[0]?.[0];
		expect(callArgs).toMatchObject({
			kind: "BUG",
			skipClassifier: true,
			labels: ["bug"],
		});
	});

	it("no kindOverride keeps legacy behavior (classifier still runs)", async () => {
		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({ kind: "BUG" }),
		);
		const change = makeBugChange();
		await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog: EMPTY_BACKLOG,
		});
		const callArgs = mocks.createStoryFromProposal.mock.calls[0]?.[0];
		// kind hint is "BUG" (from change.type), skipClassifier left unset.
		expect(callArgs.kind).toBe("BUG");
		expect(callArgs.skipClassifier).toBeFalsy();
	});

	it("CREATE with a genuinely novel title is NOT blocked", async () => {
		// Regression guard: dedup must not over-fire. A proposal whose title
		// doesn't collide with anything in the backlog should sail through.
		const existingBacklog = {
			epics: [],
			features: [],
			stories: [
				{
					id: "unrelated-1",
					identifier: "B-001",
					title: "Pricing page misaligned on mobile",
					description: null,
					featureId: null,
					externalId: null,
				},
			],
		};

		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({
				id: "novel-bug",
				identifier: "B-002",
				title: "Login crashes on Safari",
			}),
		);

		const change = makeBugChange({
			title: { to: "Login crashes on Safari", from: null },
		});

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog,
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledOnce();
		expect(result.appliedCount).toBe(1);
		expect(result.createdItems[0]?.id).toBe("novel-bug");
		expect(result.errors).toHaveLength(0);
	});
});

// =============================================================================
// Epic normalization (unconditional — the Epic/Feature folder tables were dropped)
// =============================================================================
//
// `epic` is no longer a supported work-item type anywhere: an epic-typed
// CREATE (e.g. from an already-stored proposal) is normalized to `feature` and
// materialized as a roadmap UserStory(kind=FEATURE) for EVERY caller — the
// behavior that used to be the channel-monitor `forbidEpics: true` opt-in
// (Bug 1429) is now the default and the flag is a deprecated no-op.

function makeEpicChange(overrides: Record<string, unknown> = {}) {
	return {
		action: "create" as const,
		type: "epic" as const,
		title: { to: "Mobile App Launch", from: null },
		description: {
			to: "Strategic initiative spanning multiple features.",
			from: null,
		},
		acceptanceCriteria: undefined,
		priority: { to: "P1_HIGH", from: null },
		size: { to: "XL", from: null },
		parentFeatureIdentifier: undefined,
		parentFeatureTitle: undefined,
		existingExternalId: undefined,
		reasoning: "test fixture — epic change",
		sourceContext: "test fixture — synthetic",
		...overrides,
	};
}

describe("applyBacklogChanges → unconditional epic→feature normalization", () => {
	it("an epic-typed CREATE is normalized to a feature and becomes a roadmap UserStory (no forbidEpics flag needed)", async () => {
		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({
				kind: "FEATURE",
				id: "feat-1",
				identifier: "F-200",
				title: "Mobile App Launch",
			}),
		);
		const change = makeEpicChange();

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog: EMPTY_BACKLOG,
			// forbidEpics deliberately OMITTED — normalization is unconditional.
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledOnce();
		const callArgs = mocks.createStoryFromProposal.mock.calls[0]?.[0];
		expect(callArgs).toMatchObject({
			projectId: "project-1",
			title: "Mobile App Launch",
			kind: "FEATURE",
			skipClassifier: true,
		});
		// One item applied, reported under the normalized `feature` type with
		// a feature→story PM-sync type correction.
		expect(result.appliedCount).toBe(1);
		expect(result.createdItems).toHaveLength(1);
		expect(result.createdItems[0]).toMatchObject({
			type: "feature",
			id: "feat-1",
			identifier: "F-200",
		});
		expect(result.typeCorrections[0]).toBe("story");
	});

	it("forbidEpics:true behaves identically (deprecated flag, no behavior change)", async () => {
		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({
				kind: "FEATURE",
				id: "feat-1b",
				identifier: "F-202",
				title: "Mobile App Launch",
			}),
		);

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [makeEpicChange()],
			existingBacklog: EMPTY_BACKLOG,
			forbidEpics: true,
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledOnce();
		expect(result.createdItems[0]).toMatchObject({
			type: "feature",
			id: "feat-1b",
		});
		expect(result.typeCorrections[0]).toBe("story");
	});

	it("logs a warn for the epic→feature normalization", async () => {
		const { logger } = (await import("@repo/logs")) as unknown as {
			logger: { warn: ReturnType<typeof vi.fn> };
		};
		(logger.warn as ReturnType<typeof vi.fn>).mockClear();
		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({
				kind: "FEATURE",
				id: "feat-2",
				identifier: "F-201",
			}),
		);

		await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [makeEpicChange()],
			existingBacklog: EMPTY_BACKLOG,
		});

		const calls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
		const sawEpicWarning = calls.some(
			(c) =>
				typeof c[0] === "string" &&
				c[0].toLowerCase().includes("epic") &&
				c[0].toLowerCase().includes("feature"),
		);
		expect(sawEpicWarning).toBe(true);
	});

	it("an epic-typed UPDATE is normalized and resolves against the flat story list (updateStory, type corrected to story)", async () => {
		// A valid Fabric UUID for a row that lives in the (flat) story backlog —
		// the normalized (epic→feature) update resolves to updateStory with a
		// feature→story type correction.
		const STORY_UUID = "11111111-1111-4111-8111-111111111111";
		const existingBacklog = {
			stories: [
				{
					id: STORY_UUID,
					identifier: "F-300",
					title: "Existing feature",
					description: "Original description",
					externalId: null,
				},
			],
		};
		const change = makeEpicChange({
			action: "update",
			existingId: STORY_UUID,
			existingIdentifier: "F-300",
			title: { from: "Existing feature", to: "Renamed initiative" },
		});

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog,
		});

		// The update lands on the user_story row.
		expect(mocks.updateStory).toHaveBeenCalledOnce();
		expect(mocks.updateStory).toHaveBeenCalledWith(
			STORY_UUID,
			"project-1",
			expect.objectContaining({ title: "Renamed initiative" }),
			expect.objectContaining({ lastEditedSource: "AI_BACKLOG_UPDATE" }),
		);
		expect(result.updatedItems[0]).toMatchObject({
			type: "story",
			id: STORY_UUID,
		});
		// PM-sync gate gets the corrected leaf type.
		expect(result.typeCorrections[0]).toBe("story");
	});

	it("an epic-typed UPDATE that cannot be resolved falls back to a CREATE (roadmap UserStory)", async () => {
		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({
				kind: "FEATURE",
				id: "feat-fb",
				identifier: "F-401",
				title: "Renamed epic",
			}),
		);
		const change = makeEpicChange({
			action: "update",
			existingId: "ado-12345", // not a Fabric CUID/UUID
			existingIdentifier: "EPIC-009", // not in the (flat) backlog
			title: { from: "Existing epic", to: "Renamed epic" },
		});

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledOnce();
		expect(mocks.createStoryFromProposal.mock.calls[0]?.[0]).toMatchObject({
			kind: "FEATURE",
			skipClassifier: true,
		});
		expect(result.createdItems[0]).toMatchObject({
			type: "feature",
			id: "feat-fb",
		});
		expect(result.typeCorrections[0]).toBe("story");
	});
});

// =============================================================================
// convertedToCreate reporting (unresolvable UPDATE → CREATE fallback)
// =============================================================================
//
// When an update change carries a non-Fabric existingId and no identifier /
// externalId / title matches anything in the provided backlog, the resolver
// returns {status:"unresolved"} and the apply path falls back to creating a new
// item. The fallback must be RECORDED in convertedToCreate (not silent) so the
// reviewer can see that the AI's "update FEAT-023" actually became a new row.

describe("applyBacklogChanges → convertedToCreate reporting", () => {
	it("records an unresolvable UPDATE fallback in convertedToCreate with the correct changeIndex and proposedTitle", async () => {
		// The backlog has one story, but its identifier/externalId/title do NOT
		// match anything the change references — so all three resolver strategies
		// will miss.
		const existingBacklog = {
			stories: [
				{
					id: "11111111-1111-4111-8111-111111111111",
					identifier: "F-001",
					title: "Some unrelated story",
					description: null,
					externalId: null,
				},
			],
		};

		mocks.createStoryFromProposal.mockResolvedValueOnce(
			makeCreatedStory({
				id: "new-story-from-fallback",
				identifier: "F-999",
				title: "Add real-time collaboration",
				kind: "FEATURE",
			}),
		);

		// An UPDATE whose existingId is a non-Fabric token ("FEAT-023") and whose
		// existingIdentifier does NOT match any story in existingBacklog.
		const change = makeFeatureChange({
			action: "update",
			existingId: "FEAT-023", // not a Fabric CUID/UUID
			existingIdentifier: "FEAT-023", // not in the backlog
			title: { to: "Add real-time collaboration", from: "Old title" },
		});

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [change],
			existingBacklog,
		});

		// The fallback create must have been executed.
		expect(mocks.createStoryFromProposal).toHaveBeenCalledOnce();
		expect(result.createdItems).toHaveLength(1);
		expect(result.createdItems[0]).toMatchObject({
			id: "new-story-from-fallback",
		});

		// The conversion must be reported — not silent.
		expect(result.convertedToCreate).toHaveLength(1);
		expect(result.convertedToCreate[0]).toMatchObject({
			changeIndex: 0,
			proposedTitle: "Add real-time collaboration",
		});
		// attemptedReference should be the existingIdentifier (first non-null ref).
		expect(result.convertedToCreate[0]?.attemptedReference).toBe(
			"FEAT-023",
		);
	});
});
