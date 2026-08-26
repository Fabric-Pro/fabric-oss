/**
 * Tests for the AI-Update terminal-state gate in applyBacklogChanges.
 *
 * An `action:"update"` whose resolved target is in a terminal lifecycle state
 * (CLOSED / DECLINED / pmAutoHidden) must NOT mutate that immutable record —
 * the change is redirected into a NEW ticket that carries a `supersedes:<id>`
 * label + a provenance footer and is deliberately NOT linked to the closed
 * ticket's PM card. Non-terminal targets are updated exactly as before.
 *
 * Hermetic: db, createStoryFromProposal, updateStory, recordAudit and the
 * duplicate-detection enqueue are all mocked (mirrors apply-backlog-changes.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		createStoryFromProposal: vi.fn(),
		updateStory: vi.fn(),
		tenantWhere: vi.fn(() => ({
			organizationId: "org-1",
			userId: "user-1",
		})),
		dbProjectFindFirst: vi.fn(),
		dbUserStoryFindMany: vi.fn(),
		dbUserStoryFindFirst: vi.fn(),
		recordAudit: vi.fn(),
		heartbeat: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
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
	updateStory: mocks.updateStory,
	recordAudit: mocks.recordAudit,
	normalizeBacklogTitle: (title: string) =>
		title
			.toLowerCase()
			.trim()
			.replace(/^\[bug\]\s+/i, "")
			.trim(),
	// Mirror the real predicate so the gate logic is exercised faithfully.
	TERMINAL_DRAFTING_STAGES: ["DECLINED", "CLOSED"],
	isTerminalWorkItemState: (item: {
		draftingStage: string;
		pmAutoHidden: boolean;
	}) =>
		["DECLINED", "CLOSED"].includes(item.draftingStage) ||
		item.pmAutoHidden === true,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: mocks.heartbeat }));

vi.mock("../src/lib/create-story-from-proposal", () => ({
	createStoryFromProposal: mocks.createStoryFromProposal,
}));

vi.mock("../src/lib/trigger-duplicate-detection", () => ({
	triggerDuplicateDetection: vi.fn(async () => ({ workflowId: "dup-test" })),
}));

import {
	applyBacklogChanges,
	type ChangeProposal,
} from "../src/activities/backlog-context/analyze-context";

const EMPTY_BACKLOG = { stories: [] };

// Valid Fabric UUIDs (pass the isValidFabricId check → resolution skipped, the
// gate fetch decides terminal-ness).
const CLOSED_ID = "11111111-1111-1111-1111-111111111111";
const DECLINED_ID = "22222222-2222-2222-2222-222222222222";
const HIDDEN_ID = "33333333-3333-3333-3333-333333333333";
const OPEN_ID = "44444444-4444-4444-4444-444444444444";

function terminalRow(
	draftingStage: string,
	pmAutoHidden: boolean,
	identifier: string,
) {
	return {
		kind: "FEATURE" as const,
		title: "Original closed title",
		identifier,
		description: "Original body",
		acceptanceCriteria: null,
		labels: [],
		draftingStage,
		pmAutoHidden,
	};
}

// The gate makes TWO findFirst calls per terminal update: the lifecycle fetch
// (by id) and the idempotency check (by `labels has supersedes:<id>`). Return
// the row for the id fetch and null for the idempotency check (no prior
// superseder) so the redirect proceeds in these tests.
function gateReturns(row: unknown) {
	mocks.dbUserStoryFindFirst.mockImplementation(
		async ({ where }: { where: Record<string, unknown> }) =>
			where && "labels" in where ? null : row,
	);
}

function makeUpdate(
	overrides: Record<string, unknown> = {},
): ChangeProposal["changes"][number] {
	return {
		action: "update" as const,
		type: "feature" as const,
		existingId: CLOSED_ID,
		existingIdentifier: "F-042",
		existingExternalId: undefined,
		title: { to: "Add SSO login option", from: "Original closed title" },
		description: { to: "Updated SSO body", from: "Original body" },
		acceptanceCriteria: undefined,
		priority: { to: "P2_MEDIUM", from: "P2_MEDIUM" },
		size: { to: "L", from: "L" },
		reasoning: "test fixture — update change",
		sourceContext: "test fixture — synthetic",
		...overrides,
	} as unknown as ChangeProposal["changes"][number];
}

function makeCreatedStory(
	o: Partial<{ id: string; identifier: string; title: string }> = {},
) {
	return {
		story: {
			id: o.id ?? "new-story-1",
			identifier: o.identifier ?? "F-100",
			title: o.title ?? "Add SSO login option",
			kind: "FEATURE" as const,
			description: "Drafted redirect body",
		},
		aiDrafted: false,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.dbProjectFindFirst.mockResolvedValue({ id: "project-1" });
	mocks.dbUserStoryFindMany.mockResolvedValue([]); // no terminal ids by default
	mocks.dbUserStoryFindFirst.mockResolvedValue(null);
	mocks.createStoryFromProposal.mockResolvedValue(makeCreatedStory());
	mocks.updateStory.mockResolvedValue({ id: "new-story-1" });
});

function updateStoryCallsWithExternalId() {
	return mocks.updateStory.mock.calls.filter(
		(call) => call[2] && Object.hasOwn(call[2] as object, "externalId"),
	);
}

describe("applyBacklogChanges → terminal-state gate", () => {
	it("AC-1: redirects an update targeting a CLOSED ticket to a new ticket, leaving the closed row untouched", async () => {
		gateReturns(terminalRow("CLOSED", false, "F-042"));

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [makeUpdate()],
			existingBacklog: EMPTY_BACKLOG,
		});

		// New ticket created via the create helper (kind classification path).
		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		// The closed row was NEVER written: the only updateStory call is the
		// footer append against the NEW row (never the closed itemId, never a
		// field-diff update, never an externalId link).
		for (const call of mocks.updateStory.mock.calls) {
			expect(call[0]).not.toBe(CLOSED_ID);
		}
		expect(result.updatedItems).toHaveLength(0);
		expect(result.createdItems).toHaveLength(1);
		expect(result.appliedCount).toBe(1);
		// Reference recorded.
		expect(result.redirectedTerminalUpdates).toEqual([
			{
				changeIndex: 0,
				closedId: CLOSED_ID,
				closedIdentifier: "F-042",
				newId: "new-story-1",
				newIdentifier: "F-100",
				proposedTitle: "Add SSO login option",
			},
		]);
	});

	it("AC-2: redirects an update targeting a pmAutoHidden ticket (pmAutoHidden clause)", async () => {
		// draftingStage non-terminal but pmAutoHidden=true → still terminal.
		gateReturns(terminalRow("DRAFT", true, "F-044"));

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [makeUpdate({ existingId: HIDDEN_ID })],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		expect(result.updatedItems).toHaveLength(0);
		expect(result.redirectedTerminalUpdates?.[0]?.closedId).toBe(HIDDEN_ID);
	});

	it("redirects an update targeting a DECLINED ticket", async () => {
		gateReturns(terminalRow("DECLINED", false, "F-043"));

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [makeUpdate({ existingId: DECLINED_ID })],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(result.redirectedTerminalUpdates?.[0]?.closedId).toBe(
			DECLINED_ID,
		);
		expect(result.createdItems).toHaveLength(1);
	});

	it("AC-3 / AC-10: a non-terminal (open) update is applied normally — no redirect, no new ticket", async () => {
		gateReturns(terminalRow("DRAFT", false, "F-045"));

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			// Title-only change so the structure-preserving merge path is skipped.
			approvedChanges: [
				makeUpdate({
					existingId: OPEN_ID,
					description: undefined,
					title: {
						to: "Renamed open feature",
						from: "Original closed title",
					},
				}),
			],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
		expect(result.createdItems).toHaveLength(0);
		expect(result.redirectedTerminalUpdates).toHaveLength(0);
		// The open row WAS updated.
		expect(mocks.updateStory.mock.calls.some((c) => c[0] === OPEN_ID)).toBe(
			true,
		);
		expect(result.updatedItems).toHaveLength(1);
	});

	it("AC-4: a mixed batch handles terminal + non-terminal items independently with accurate counts", async () => {
		mocks.dbUserStoryFindFirst.mockImplementation(
			async ({ where }: { where: { id: string } }) => {
				if (where.id === CLOSED_ID) {
					return terminalRow("CLOSED", false, "F-042");
				}
				if (where.id === OPEN_ID) {
					return terminalRow("DRAFT", false, "F-045");
				}
				return null;
			},
		);

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [
				makeUpdate({ existingId: CLOSED_ID }),
				makeUpdate({
					existingId: OPEN_ID,
					description: undefined,
					title: {
						to: "Renamed open feature",
						from: "Original closed title",
					},
				}),
			],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(result.createdItems).toHaveLength(1); // redirect
		expect(result.updatedItems).toHaveLength(1); // open update
		expect(result.redirectedTerminalUpdates).toHaveLength(1);
		expect(result.appliedCount).toBe(2);
	});

	it("REQ-4: the new ticket carries a supersedes label + a provenance footer, and inherits PM sync", async () => {
		gateReturns(terminalRow("CLOSED", false, "F-042"));

		await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [makeUpdate()],
			existingBacklog: EMPTY_BACKLOG,
			syncToPM: true,
		});

		// Label + PM-sync inheritance on create (AC-7 / REQ-13).
		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				labels: expect.arrayContaining(["supersedes:F-042"]),
				enablePmAutoSync: true,
			}),
		);
		// Human-readable footer appended to the persisted body post-create.
		expect(mocks.updateStory).toHaveBeenCalledWith(
			"new-story-1",
			"project-1",
			expect.objectContaining({
				description: expect.stringContaining(
					"Supersedes closed ticket F-042",
				),
			}),
			expect.objectContaining({ lastEditedSource: "AI_BACKLOG_UPDATE" }),
		);
	});

	it("does NOT bind the new ticket to the closed ticket's PM card (no externalId leak)", async () => {
		gateReturns(terminalRow("CLOSED", false, "F-042"));

		await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [
				makeUpdate({ existingExternalId: "PM-CARD-999" }),
			],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		// No updateStory call links an externalId anywhere.
		expect(updateStoryCallsWithExternalId()).toHaveLength(0);
	});

	it("AC-6: the redirect-created ticket is still deduped against an existing NON-terminal same-title row", async () => {
		gateReturns(terminalRow("CLOSED", false, "F-042"));
		// No terminal ids → the non-terminal blocker stays in the dedup index.
		mocks.dbUserStoryFindMany.mockResolvedValue([]);

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [
				makeUpdate({ title: { to: "SSO login", from: "x" } }),
			],
			existingBacklog: {
				stories: [
					{
						id: "blocker-1",
						identifier: "F-200",
						title: "SSO login",
						description: null,
						externalId: null,
					},
				],
			},
		});

		// Redirect attempted, but the create was skipped as a duplicate.
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
		expect(result.createdItems).toHaveLength(0);
		expect(result.redirectedTerminalUpdates).toHaveLength(0);
		expect(result.skippedDuplicates).toHaveLength(1);
	});

	it("dedup index EXCLUDES terminal rows: a fresh create whose title matches a CLOSED row is NOT skipped", async () => {
		// The same-title existing row is terminal (its id is returned by the
		// terminal-id fetch), so it must not block the create.
		mocks.dbUserStoryFindMany.mockResolvedValue([{ id: "closed-blocker" }]);

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [
				makeUpdate({
					action: "create",
					existingId: undefined,
					title: { to: "Recurring topic", from: null },
				}),
			],
			existingBacklog: {
				stories: [
					{
						id: "closed-blocker",
						identifier: "F-300",
						title: "Recurring topic",
						description: null,
						externalId: null,
					},
				],
			},
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		expect(result.createdItems).toHaveLength(1);
		expect(result.skippedDuplicates).toHaveLength(0);
	});

	it("idempotency: redirect is skipped when the closed source is already superseded (retry-safe)", async () => {
		mocks.dbUserStoryFindFirst.mockImplementation(
			async ({ where }: { where: Record<string, unknown> }) => {
				if (where && "labels" in where) {
					return {
						id: "existing-superseder",
						identifier: "F-150",
						title: "Existing superseder ticket",
					};
				}
				return terminalRow("CLOSED", false, "F-042");
			},
		);

		const result = await applyBacklogChanges({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			approvedChanges: [makeUpdate()],
			existingBacklog: EMPTY_BACKLOG,
		});

		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
		expect(result.createdItems).toHaveLength(0);
		expect(result.redirectedTerminalUpdates).toHaveLength(0);
		expect(result.skippedDuplicates).toHaveLength(1);
		expect(result.skippedDuplicates[0]?.existingId).toBe(
			"existing-superseder",
		);
	});
});
