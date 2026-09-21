/**
 * The To Do page's tie to the Feature Proposals inbox (#2340):
 * `todos.pendingProposals`, `todos.linkedWorkItems` and
 * `todos.manageProposalLink`.
 *
 * Two seams, the split this repository uses for procedures (see
 * `./mutations.test.ts` and
 * `modules/function-tags/procedures/__tests__/project.test.ts`):
 *
 *  1. **Schema level.** `.input()` is a no-op in the stubbed procedure chain
 *     below, so each input schema is parsed directly.
 *  2. **Handler level.** `@repo/database` is mocked, so what is asserted is
 *     which rows each handler loads, which of the three resolution addresses it
 *     used, and — for the write — which shared writer it called and with what.
 *
 * WHAT THE AUTHORIZATION TESTS HERE ARE FOR. The permission GATE cannot run:
 * `.use()` is a no-op in the stub, so what is pinned about it is the
 * DECLARATION. Everything else is the SECOND half of the rule, which is where
 * the real risk sits — these procedures are keyed by TO-DO id and read or write
 * a PROJECT's meeting digest, and organization membership says nothing about
 * which of that organization's projects a caller may touch.
 *
 * `computeActionItemKey` and `TODO_BINDING_VERSION` are deliberately NOT mocked
 * (the module spreads the real exports): the tombstone's `itemKey` and the
 * proposal's key version are the two values that decide whether this surface and
 * the digest agree, so a test that stubbed them would prove nothing.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/todos
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../../../lib/missing-organization-context";

const mocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	loadTodoForMutation: vi.fn(),
	resolveBoundActionItem: vi.fn(),
	upsertPersonLink: vi.fn(),
	dismissActionItemLink: vi.fn(),
	assertProjectPermission: vi.fn(),
	dbMock: {
		// `findMany` is the write rule's own question: which projects can this
		// caller reach, asked once per request by `resolveTodoVisibility`.
		project: { findFirst: vi.fn(), findMany: vi.fn() },
		projectUserFunctionTag: { findMany: vi.fn() },
		projectMeetingTranscript: { findFirst: vi.fn(), findMany: vi.fn() },
		pendingBacklogProposal: { findMany: vi.fn() },
		meetingActionItemLink: { findMany: vi.fn(), findUnique: vi.fn() },
		userStory: { findMany: vi.fn(), findFirst: vi.fn() },
	},
	captured: {} as Record<
		string,
		(args: { context: any; input: any }) => Promise<any>
	>,
	declared: {} as Record<
		string,
		{ permission: string; options?: { requireOrganization?: boolean } }[]
	>,
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: mocks.dbMock,
		isFeatureEnabled: mocks.isFeatureEnabled,
		loadTodoForMutation: mocks.loadTodoForMutation,
		resolveBoundActionItem: mocks.resolveBoundActionItem,
		upsertPersonLink: mocks.upsertPersonLink,
		dismissActionItemLink: mocks.dismissActionItemLink,
	};
});

vi.mock("../../../../orpc/procedures", () => {
	let pendingKey = "";
	const chainable: any = {
		use: (declaration: {
			permission: string;
			options?: { requireOrganization?: boolean };
		}) => {
			mocks.declared[pendingKey] ??= [];
			mocks.declared[pendingKey].push(declaration);
			return chainable;
		},
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			mocks.captured[pendingKey] = fn as any;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		// Mirrors the real resolver: an explicit string wins, an explicit null
		// means "no organization" and deliberately does NOT fall back to the
		// session, and `undefined` falls back.
		resolveOrganizationId: vi.fn(
			(
				organizationId: string | null | undefined,
				session?: { activeOrganizationId?: string | null },
			) => {
				if (organizationId) {
					return organizationId;
				}
				if (organizationId === null) {
					return undefined;
				}
				return session?.activeOrganizationId ?? undefined;
			},
		),
		requireInputOrgPermission: vi.fn(
			(
				permission: string,
				options?: { requireOrganization?: boolean },
			) => ({ permission, options }),
		),
		assertProjectPermission: (...args: unknown[]) =>
			mocks.assertProjectPermission(...args),
		Permissions: new Proxy({}, { get: (_: unknown, prop: string) => prop }),
		__setPendingHandlerKey(key: string) {
			pendingKey = key;
		},
	};
});

const procedures = await import("../../../../orpc/procedures");
const setSlot = (
	procedures as unknown as { __setPendingHandlerKey: (key: string) => void }
).__setPendingHandlerKey;

// Imported AFTER each slot is set: the stubbed chain files the handler under
// whichever slot is pending, so a static import would file it under no name.
setSlot("pendingProposals");
const { pendingProposalMeetingsInputSchema } = await import(
	"../pending-proposals"
);
setSlot("linkedWorkItems");
const { todoLinkedWorkItemsInputSchema } = await import("../linked-work-items");
setSlot("manageProposalLink");
const { manageProposalLinkInputSchema } = await import(
	"../manage-proposal-link"
);

const { computeActionItemKey, TODO_BINDING_VERSION } = await import(
	"@repo/database"
);

const ORG = "org-1";
const VIEWER = "user-1";
const PROJECT = "proj-1";
const TRANSCRIPT_ROW = "transcript-row-1";
const TRANSCRIPT_REF = "graph-transcript-1";
const TODO_ITEM_KEY = "todo-item-key-1";
const LIVE_TEXT = "Ship the onboarding rewrite";

const baseCtx = {
	user: { id: VIEWER, email: "alice@example.com", name: "Alice" },
	session: { id: "sess-1", activeOrganizationId: ORG },
};

/** A meeting-sourced to-do owned by the viewer, bound to the transcript above. */
const meetingTodo = {
	id: "todo-1",
	source: "MEETING_DIGEST" as const,
	transcriptId: TRANSCRIPT_ROW,
	itemKey: TODO_ITEM_KEY,
	occurrenceIndex: 0,
	itemTextSnapshot: LIVE_TEXT,
	title: null,
	projectId: PROJECT,
	userId: VIEWER,
	organizationId: ORG,
	assigneeUserId: VIEWER,
	assigneeContactId: null,
	assignedManually: false,
	snoozedUntil: null,
	completedAt: null,
	completedById: null,
	lastKnownCompletedAt: null,
	sourceDate: new Date("2026-09-01T00:00:00.000Z"),
	createdAt: new Date("2026-09-01T00:00:00.000Z"),
	updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

/** A manual to-do: no meeting, no transcript, nothing to resolve. */
const manualTodo = {
	...meetingTodo,
	id: "todo-manual",
	source: "MANUAL" as const,
	transcriptId: null,
	itemKey: null,
	occurrenceIndex: null,
	itemTextSnapshot: null,
	title: "Book the venue",
};

const transcriptRow = {
	id: TRANSCRIPT_ROW,
	transcriptId: TRANSCRIPT_REF,
	projectId: PROJECT,
	// Tenancy the link rows must COPY — deliberately not the caller's.
	userId: "meeting-owner",
	organizationId: ORG,
};

const storyRow = {
	id: "story-1",
	identifier: "US-042",
	title: "Rewrite onboarding",
	kind: "FEATURE" as const,
	status: { name: "In Progress", isFinal: false },
};

/** Both flags on unless a test says otherwise. */
function setFlags({
	todoList = true,
	linking = true,
}: {
	todoList?: boolean;
	linking?: boolean;
} = {}) {
	mocks.isFeatureEnabled.mockImplementation(async (key: string) =>
		key === "TODO_LIST" ? todoList : linking,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	// `clearAllMocks` clears recorded calls but NOT a queued
	// `mockResolvedValueOnce`. The resolution helper queues two values and the
	// key-hit path consumes only the first, so without this reset the leftover
	// shifts the next test's queue by one and that test silently exercises the
	// wrong branch.
	mocks.dbMock.pendingBacklogProposal.findMany.mockReset();
	setFlags();
	mocks.loadTodoForMutation.mockResolvedValue(meetingTodo);
	mocks.resolveBoundActionItem.mockResolvedValue({
		id: "action-item-live",
		text: LIVE_TEXT,
		completedAt: null,
	});
	// The caller's visibility scope: they reach the project these to-dos sit
	// on, and hold no confirmed function tag anywhere.
	mocks.dbMock.project.findMany.mockResolvedValue([
		{ id: PROJECT, userId: "user-creator", members: [] },
	]);
	mocks.dbMock.projectUserFunctionTag.findMany.mockResolvedValue([]);
	mocks.dbMock.projectMeetingTranscript.findFirst.mockResolvedValue(
		transcriptRow,
	);
	mocks.dbMock.projectMeetingTranscript.findMany.mockResolvedValue([]);
	mocks.dbMock.pendingBacklogProposal.findMany.mockResolvedValue([]);
	mocks.dbMock.meetingActionItemLink.findMany.mockResolvedValue([]);
	mocks.dbMock.meetingActionItemLink.findUnique.mockResolvedValue(null);
	mocks.dbMock.userStory.findMany.mockResolvedValue([]);
	mocks.dbMock.userStory.findFirst.mockResolvedValue({ id: storyRow.id });
	mocks.assertProjectPermission.mockResolvedValue(undefined);
	mocks.upsertPersonLink.mockResolvedValue({ id: "link-new" });
	mocks.dismissActionItemLink.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Schema level — the real guard behind `.input(...)`
// ---------------------------------------------------------------------------

describe("input schemas", () => {
	it("the pending signal asks about at least one and at most 100 meetings", () => {
		expect(
			pendingProposalMeetingsInputSchema.safeParse({
				transcriptRefs: [],
			}).success,
		).toBe(false);
		expect(
			pendingProposalMeetingsInputSchema.safeParse({
				transcriptRefs: [""],
			}).success,
		).toBe(false);
		expect(
			pendingProposalMeetingsInputSchema.safeParse({
				transcriptRefs: Array.from({ length: 101 }, (_, i) => `r${i}`),
			}).success,
		).toBe(false);
		expect(
			pendingProposalMeetingsInputSchema.safeParse({
				organizationId: ORG,
				transcriptRefs: [TRANSCRIPT_REF],
			}).success,
		).toBe(true);
	});

	it("the linked work items read needs a to-do", () => {
		expect(
			todoLinkedWorkItemsInputSchema.safeParse({ todoId: "" }).success,
		).toBe(false);
		expect(
			todoLinkedWorkItemsInputSchema.safeParse({ todoId: "todo-1" })
				.success,
		).toBe(true);
	});

	it("managing a link takes one of exactly two directions", () => {
		expect(
			manageProposalLinkInputSchema.safeParse({
				todoId: "todo-1",
				storyId: "story-1",
				action: "remove",
			}).success,
		).toBe(false);
		expect(
			manageProposalLinkInputSchema.safeParse({
				todoId: "todo-1",
				storyId: "",
				action: "reject",
			}).success,
		).toBe(false);
		for (const action of ["accept", "reject"]) {
			expect(
				manageProposalLinkInputSchema.safeParse({
					todoId: "todo-1",
					storyId: "story-1",
					action,
				}).success,
			).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// The declared gate — the first of the two authorization layers
// ---------------------------------------------------------------------------

describe("declared organization gate", () => {
	it.each([
		["pendingProposals", "TODO_READ"],
		["linkedWorkItems", "TODO_READ"],
		["manageProposalLink", "TODO_UPDATE"],
	])("%s declares %s with requireOrganization", (slot, permission) => {
		const declarations = mocks.declared[slot];
		expect(declarations).toBeDefined();
		expect(declarations).toEqual([
			{ permission, options: { requireOrganization: true } },
		]);
	});
});

// ---------------------------------------------------------------------------
// 1. The pending-proposal signal, at meeting granularity
// ---------------------------------------------------------------------------

describe("todos.pendingProposals", () => {
	const OTHER_ROW = "transcript-row-2";
	const OTHER_REF = "graph-transcript-2";

	function twoMeetings() {
		mocks.dbMock.projectMeetingTranscript.findMany.mockResolvedValue([
			{ ...transcriptRow, analyzedProposalId: null },
			{
				id: OTHER_ROW,
				transcriptId: OTHER_REF,
				projectId: PROJECT,
				analyzedProposalId: null,
			},
		]);
	}

	it("reports the meeting that has pending proposals and not the one that has none", async () => {
		twoMeetings();
		mocks.dbMock.pendingBacklogProposal.findMany.mockResolvedValue([
			{
				id: "proposal-1",
				sourceMetadata: { transcriptRecordId: TRANSCRIPT_ROW },
			},
			{
				id: "proposal-2",
				sourceMetadata: { transcriptRecordId: TRANSCRIPT_ROW },
			},
		]);

		const result = await mocks.captured.pendingProposals({
			context: baseCtx,
			input: {
				organizationId: ORG,
				transcriptRefs: [TRANSCRIPT_REF, OTHER_REF],
			},
		});

		expect(result.meetings).toEqual([
			{
				transcriptRef: TRANSCRIPT_REF,
				projectId: PROJECT,
				pendingCount: 2,
			},
		]);
	});

	it("only counts rows still awaiting review, in projects the caller can reach", async () => {
		twoMeetings();
		await mocks.captured.pendingProposals({
			context: baseCtx,
			input: {
				organizationId: ORG,
				// Deduplicated: the page sends one ref per rendered row.
				transcriptRefs: [TRANSCRIPT_REF, TRANSCRIPT_REF, OTHER_REF],
			},
		});

		const transcriptWhere =
			mocks.dbMock.projectMeetingTranscript.findMany.mock.calls[0][0]
				.where;
		expect(transcriptWhere.transcriptId).toEqual({
			in: [TRANSCRIPT_REF, OTHER_REF],
		});
		expect(transcriptWhere.organizationId).toBe(ORG);
		// The project-access predicate from `../lib/visibility.ts`, not a
		// restatement of it: the soft-delete exclusion is what identifies it.
		expect(transcriptWhere.project.organizationId).toBe(ORG);
		expect(transcriptWhere.project.deletedAt).toBeNull();

		const proposalWhere =
			mocks.dbMock.pendingBacklogProposal.findMany.mock.calls[0][0].where;
		expect(proposalWhere.status).toBe("PENDING");
		expect(proposalWhere.projectId).toEqual({ in: [PROJECT] });
	});

	it("counts a meeting-level proposal through the transcript back-link", async () => {
		mocks.dbMock.projectMeetingTranscript.findMany.mockResolvedValue([
			{ ...transcriptRow, analyzedProposalId: "proposal-meeting" },
		]);
		mocks.dbMock.pendingBacklogProposal.findMany.mockResolvedValue([
			// No sourceMetadata at all — the auto-analyze shape this indicator
			// would miss if it only read `transcriptRecordId`.
			{ id: "proposal-meeting", sourceMetadata: null },
		]);

		const result = await mocks.captured.pendingProposals({
			context: baseCtx,
			input: { organizationId: ORG, transcriptRefs: [TRANSCRIPT_REF] },
		});

		expect(result.meetings).toEqual([
			{
				transcriptRef: TRANSCRIPT_REF,
				projectId: PROJECT,
				pendingCount: 1,
			},
		]);
	});

	it("still answers when MEETING_ACTION_ITEM_LINKING is off", async () => {
		setFlags({ linking: false });
		twoMeetings();
		mocks.dbMock.pendingBacklogProposal.findMany.mockResolvedValue([
			{
				id: "proposal-1",
				sourceMetadata: { transcriptRecordId: TRANSCRIPT_ROW },
			},
		]);

		const result = await mocks.captured.pendingProposals({
			context: baseCtx,
			input: { organizationId: ORG, transcriptRefs: [TRANSCRIPT_REF] },
		});

		expect(result.meetings).toHaveLength(1);
		// The inbox is not behind the linking flag, and this read must never
		// consult it — turning the linking rollout off would otherwise take the
		// review queue's indicator with it.
		expect(mocks.isFeatureEnabled).not.toHaveBeenCalledWith(
			"MEETING_ACTION_ITEM_LINKING",
		);
	});

	it("is absent when the To Do page is switched off", async () => {
		setFlags({ todoList: false });
		await expect(
			mocks.captured.pendingProposals({
				context: baseCtx,
				input: {
					organizationId: ORG,
					transcriptRefs: [TRANSCRIPT_REF],
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(
			mocks.dbMock.projectMeetingTranscript.findMany,
		).not.toHaveBeenCalled();
	});

	it("refuses a caller who names no organization", async () => {
		await expect(
			mocks.captured.pendingProposals({
				context: baseCtx,
				input: {
					organizationId: null,
					transcriptRefs: [TRANSCRIPT_REF],
				},
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
		});
	});

	it("tells a caller nothing about meetings outside their reach", async () => {
		// The predicate matched nothing, which is what an untied organization or
		// an unreachable project looks like from here.
		mocks.dbMock.projectMeetingTranscript.findMany.mockResolvedValue([]);
		const result = await mocks.captured.pendingProposals({
			context: { ...baseCtx, session: { activeOrganizationId: "org-2" } },
			input: {
				organizationId: "org-2",
				transcriptRefs: [TRANSCRIPT_REF],
			},
		});
		expect(result.meetings).toEqual([]);
		expect(
			mocks.dbMock.pendingBacklogProposal.findMany,
		).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 2. The work items an accepted proposal produced
// ---------------------------------------------------------------------------

describe("todos.linkedWorkItems", () => {
	function proposalQueries(
		byKey: Array<{ id: string; status: string }>,
		byId: Array<{ id: string; status: string }> = [],
	) {
		mocks.dbMock.pendingBacklogProposal.findMany
			.mockResolvedValueOnce(byKey)
			.mockResolvedValueOnce(byId);
	}

	it("resolves by the stable key after a re-extraction preserved the text", async () => {
		// The row id the proposal recorded is long gone; the key is not.
		proposalQueries([{ id: "proposal-1", status: "APPLIED" }]);
		mocks.dbMock.userStory.findMany.mockResolvedValue([storyRow]);

		const result = await mocks.captured.linkedWorkItems({
			context: baseCtx,
			input: { organizationId: ORG, todoId: meetingTodo.id },
		});

		const keyWhere =
			mocks.dbMock.pendingBacklogProposal.findMany.mock.calls[0][0].where;
		expect(keyWhere.projectId).toBe(PROJECT);
		expect(keyWhere.AND).toEqual([
			{
				sourceMetadata: {
					path: ["transcriptRecordId"],
					equals: TRANSCRIPT_ROW,
				},
			},
			{
				sourceMetadata: {
					path: ["actionItemKey"],
					equals: TODO_ITEM_KEY,
				},
			},
			{
				sourceMetadata: {
					path: ["actionItemKeyVersion"],
					equals: TODO_BINDING_VERSION,
				},
			},
		]);
		// The weaker address is never consulted once the stable one answered.
		expect(
			mocks.dbMock.pendingBacklogProposal.findMany,
		).toHaveBeenCalledTimes(1);

		expect(result.resolvedVia).toBe("itemKey");
		expect(result.transcriptRef).toBe(TRANSCRIPT_REF);
		expect(result.items).toEqual([
			{
				storyId: "story-1",
				identifier: "US-042",
				title: "Rewrite onboarding",
				kind: "FEATURE",
				statusName: "In Progress",
				isDone: false,
				linkId: null,
				origin: null,
				confidence: null,
				fromProposal: true,
			},
		]);
	});

	it("resolves by row id for a proposal filed before the key existed", async () => {
		proposalQueries([], [{ id: "proposal-legacy", status: "APPLIED" }]);
		mocks.dbMock.userStory.findMany.mockResolvedValue([storyRow]);

		const result = await mocks.captured.linkedWorkItems({
			context: baseCtx,
			input: { organizationId: ORG, todoId: meetingTodo.id },
		});

		const idWhere =
			mocks.dbMock.pendingBacklogProposal.findMany.mock.calls[1][0].where;
		expect(idWhere).toMatchObject({
			projectId: PROJECT,
			sourceMetadata: {
				path: ["actionItemId"],
				equals: "action-item-live",
			},
		});
		expect(result.resolvedVia).toBe("actionItemId");
		expect(
			result.items.map((item: { storyId: string }) => item.storyId),
		).toEqual(["story-1"]);
	});

	it("carries the link row so the page can reject it, and never lists a story twice", async () => {
		proposalQueries([{ id: "proposal-1", status: "APPLIED" }]);
		mocks.dbMock.meetingActionItemLink.findMany.mockResolvedValue([
			{
				id: "link-1",
				origin: "CREATED",
				confidence: null,
				story: storyRow,
			},
		]);
		mocks.dbMock.userStory.findMany.mockResolvedValue([storyRow]);

		const result = await mocks.captured.linkedWorkItems({
			context: baseCtx,
			input: { organizationId: ORG, todoId: meetingTodo.id },
		});

		// The link table is read on the LINK key, never on the to-do binding
		// key — the two digests are versioned independently.
		expect(
			mocks.dbMock.meetingActionItemLink.findMany.mock.calls[0][0].where,
		).toEqual({
			transcriptId: TRANSCRIPT_ROW,
			itemKey: computeActionItemKey(LIVE_TEXT),
			status: "ACTIVE",
		});
		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({
			storyId: "story-1",
			linkId: "link-1",
			origin: "CREATED",
			fromProposal: true,
		});
	});

	it("returns nothing and says so when MEETING_ACTION_ITEM_LINKING is off", async () => {
		setFlags({ linking: false });

		const result = await mocks.captured.linkedWorkItems({
			context: baseCtx,
			input: { organizationId: ORG, todoId: meetingTodo.id },
		});

		expect(result).toMatchObject({
			linkingEnabled: false,
			items: [],
			resolvedVia: null,
			transcriptRef: TRANSCRIPT_REF,
		});
		expect(
			mocks.dbMock.pendingBacklogProposal.findMany,
		).not.toHaveBeenCalled();
		expect(
			mocks.dbMock.meetingActionItemLink.findMany,
		).not.toHaveBeenCalled();
	});

	it("reports nothing rather than erroring for a to-do with no meeting", async () => {
		mocks.loadTodoForMutation.mockResolvedValue(manualTodo);

		const result = await mocks.captured.linkedWorkItems({
			context: baseCtx,
			input: { organizationId: ORG, todoId: manualTodo.id },
		});

		expect(result).toEqual({
			todoId: manualTodo.id,
			transcriptRef: null,
			projectId: null,
			linkingEnabled: true,
			resolvedVia: null,
			isOrphaned: false,
			items: [],
		});
		// Nothing to authorize against, and nothing queried.
		expect(mocks.assertProjectPermission).not.toHaveBeenCalled();
		expect(
			mocks.dbMock.pendingBacklogProposal.findMany,
		).not.toHaveBeenCalled();
	});

	it("marks an orphaned binding and reads no links for it", async () => {
		mocks.resolveBoundActionItem.mockResolvedValue(null);
		proposalQueries([{ id: "proposal-1", status: "APPLIED" }]);
		mocks.dbMock.userStory.findMany.mockResolvedValue([storyRow]);

		const result = await mocks.captured.linkedWorkItems({
			context: baseCtx,
			input: { organizationId: ORG, todoId: meetingTodo.id },
		});

		expect(result.isOrphaned).toBe(true);
		// No live text means no link key, so no link row can be addressed —
		// the proposal's own story is still reported.
		expect(
			mocks.dbMock.meetingActionItemLink.findMany,
		).not.toHaveBeenCalled();
		expect(result.items[0]).toMatchObject({
			storyId: "story-1",
			linkId: null,
		});
	});

	it("checks the MEETING's project, not the caller's input", async () => {
		proposalQueries([]);
		await mocks.captured.linkedWorkItems({
			context: baseCtx,
			input: { organizationId: ORG, todoId: meetingTodo.id },
		});

		expect(mocks.assertProjectPermission).toHaveBeenCalledWith(
			PROJECT,
			VIEWER,
			"PROJECT_READ",
			baseCtx,
		);
	});

	it("refuses a caller who cannot reach the meeting's project", async () => {
		mocks.assertProjectPermission.mockRejectedValue(
			new Error("FORBIDDEN: project"),
		);
		await expect(
			mocks.captured.linkedWorkItems({
				context: baseCtx,
				input: { organizationId: ORG, todoId: meetingTodo.id },
			}),
		).rejects.toThrow("FORBIDDEN: project");
		expect(
			mocks.dbMock.pendingBacklogProposal.findMany,
		).not.toHaveBeenCalled();
	});

	it("refuses a caller who names no organization", async () => {
		await expect(
			mocks.captured.linkedWorkItems({
				context: baseCtx,
				input: { organizationId: null, todoId: meetingTodo.id },
			}),
		).rejects.toMatchObject({
			data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
		});
	});

	it("does not answer for a to-do of another organization", async () => {
		mocks.loadTodoForMutation.mockResolvedValue(null);
		await expect(
			mocks.captured.linkedWorkItems({
				context: baseCtx,
				input: { organizationId: ORG, todoId: "todo-elsewhere" },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.loadTodoForMutation).toHaveBeenCalledWith({
			todoId: "todo-elsewhere",
			organizationId: ORG,
		});
	});
});

// ---------------------------------------------------------------------------
// 3. Accepting and rejecting, through the digest's own writers
// ---------------------------------------------------------------------------

describe("todos.manageProposalLink", () => {
	const acceptInput = {
		organizationId: ORG,
		todoId: meetingTodo.id,
		storyId: storyRow.id,
		action: "accept" as const,
	};
	const rejectInput = { ...acceptInput, action: "reject" as const };

	it("accepting revives or creates the link with the MEETING's tenancy", async () => {
		const result = await mocks.captured.manageProposalLink({
			context: baseCtx,
			input: acceptInput,
		});

		expect(mocks.upsertPersonLink).toHaveBeenCalledWith({
			transcriptId: TRANSCRIPT_ROW,
			projectId: PROJECT,
			itemKey: computeActionItemKey(LIVE_TEXT),
			itemTextSnapshot: LIVE_TEXT,
			storyId: storyRow.id,
			origin: "MANUAL",
			createdById: VIEWER,
			// Copied from the transcript, NOT from the caller's session: a link
			// must sit in the same RLS scope as the meeting it belongs to.
			userId: "meeting-owner",
			organizationId: ORG,
		});
		expect(result).toEqual({
			todoId: meetingTodo.id,
			storyId: storyRow.id,
			action: "accept",
			linkId: "link-new",
			status: "ACTIVE",
			changed: true,
		});
	});

	it("rejecting writes the digest's own DISMISSED tombstone", async () => {
		mocks.dbMock.meetingActionItemLink.findUnique.mockResolvedValue({
			id: "link-existing",
			status: "ACTIVE",
		});

		const result = await mocks.captured.manageProposalLink({
			context: baseCtx,
			input: rejectInput,
		});

		// Addressed on the link table's own composite unique, with the LINK key.
		expect(
			mocks.dbMock.meetingActionItemLink.findUnique.mock.calls[0][0]
				.where,
		).toEqual({
			transcriptId_itemKey_storyId: {
				transcriptId: TRANSCRIPT_ROW,
				itemKey: computeActionItemKey(LIVE_TEXT),
				storyId: storyRow.id,
			},
		});
		// The same writer `meeting-digest/manage-action-item-links.ts` calls,
		// with the same three arguments — the tombstone cannot differ because
		// nothing here writes one of its own.
		expect(mocks.dismissActionItemLink).toHaveBeenCalledWith({
			linkId: "link-existing",
			projectId: PROJECT,
			dismissedById: VIEWER,
		});
		expect(mocks.upsertPersonLink).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			action: "reject",
			linkId: "link-existing",
			status: "DISMISSED",
			changed: true,
		});
	});

	it("tombstones a proposal's work item that never got a link row", async () => {
		mocks.dbMock.meetingActionItemLink.findUnique.mockResolvedValue(null);

		const result = await mocks.captured.manageProposalLink({
			context: baseCtx,
			input: rejectInput,
		});

		// Created through the shared writer and dismissed through the shared
		// writer, so the row is the one the digest would have produced.
		expect(mocks.upsertPersonLink).toHaveBeenCalledWith(
			expect.objectContaining({
				origin: "CREATED",
				itemKey: computeActionItemKey(LIVE_TEXT),
				storyId: storyRow.id,
			}),
		);
		expect(mocks.dismissActionItemLink).toHaveBeenCalledWith({
			linkId: "link-new",
			projectId: PROJECT,
			dismissedById: VIEWER,
		});
		expect(result).toMatchObject({ status: "DISMISSED", changed: true });
	});

	it("leaves an already-rejected pair alone", async () => {
		mocks.dbMock.meetingActionItemLink.findUnique.mockResolvedValue({
			id: "link-dismissed",
			status: "DISMISSED",
		});

		const result = await mocks.captured.manageProposalLink({
			context: baseCtx,
			input: rejectInput,
		});

		expect(mocks.dismissActionItemLink).not.toHaveBeenCalled();
		expect(mocks.upsertPersonLink).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: "DISMISSED",
			changed: false,
			linkId: "link-dismissed",
		});
	});

	it("refuses a caller who cannot reach the project the tombstone lands in", async () => {
		mocks.assertProjectPermission.mockRejectedValue(
			new Error("FORBIDDEN: project"),
		);

		await expect(
			mocks.captured.manageProposalLink({
				context: baseCtx,
				input: rejectInput,
			}),
		).rejects.toThrow("FORBIDDEN: project");

		expect(mocks.assertProjectPermission).toHaveBeenCalledWith(
			PROJECT,
			VIEWER,
			"PROJECT_READ",
			baseCtx,
		);
		// Nothing was written, and the work item was never even resolved.
		expect(mocks.dbMock.userStory.findFirst).not.toHaveBeenCalled();
		expect(mocks.upsertPersonLink).not.toHaveBeenCalled();
		expect(mocks.dismissActionItemLink).not.toHaveBeenCalled();
	});

	it("reaching the to-do does not carry project reach with it", async () => {
		// The read's rule admits this row without any project: it is assigned
		// to the caller, and an organization-level row has no project for the
		// access gate to refuse. Correct for a to-do page, and exactly the hole
		// the second layer closes here — the MEETING's project is a different
		// question, answered from the transcript.
		mocks.loadTodoForMutation.mockResolvedValue({
			...meetingTodo,
			userId: VIEWER,
			projectId: null,
		});
		mocks.assertProjectPermission.mockRejectedValue(
			new Error("FORBIDDEN: project"),
		);

		await expect(
			mocks.captured.manageProposalLink({
				context: baseCtx,
				input: rejectInput,
			}),
		).rejects.toThrow("FORBIDDEN: project");
		expect(mocks.dismissActionItemLink).not.toHaveBeenCalled();
	});

	it("refuses a work item from another project", async () => {
		mocks.dbMock.userStory.findFirst.mockResolvedValue(null);

		await expect(
			mocks.captured.manageProposalLink({
				context: baseCtx,
				input: rejectInput,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.dbMock.userStory.findFirst.mock.calls[0][0].where).toEqual(
			{ id: storyRow.id, projectId: PROJECT },
		);
		expect(mocks.dismissActionItemLink).not.toHaveBeenCalled();
	});

	it("will not write a tombstone under a key the matcher does not use", async () => {
		// An orphaned to-do: its wording changed, so no live item and no link
		// key. A tombstone computed from the stale snapshot would look like a
		// rejection and prevent nothing.
		mocks.resolveBoundActionItem.mockResolvedValue(null);

		await expect(
			mocks.captured.manageProposalLink({
				context: baseCtx,
				input: rejectInput,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.upsertPersonLink).not.toHaveBeenCalled();
		expect(mocks.dismissActionItemLink).not.toHaveBeenCalled();
	});

	it("does not exist while MEETING_ACTION_ITEM_LINKING is off", async () => {
		setFlags({ linking: false });

		await expect(
			mocks.captured.manageProposalLink({
				context: baseCtx,
				input: rejectInput,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.loadTodoForMutation).not.toHaveBeenCalled();
		expect(mocks.dismissActionItemLink).not.toHaveBeenCalled();
	});

	it("does not exist while the To Do page is switched off", async () => {
		setFlags({ todoList: false });

		await expect(
			mocks.captured.manageProposalLink({
				context: baseCtx,
				input: rejectInput,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.loadTodoForMutation).not.toHaveBeenCalled();
	});

	it("refuses a caller who names no organization", async () => {
		await expect(
			mocks.captured.manageProposalLink({
				context: baseCtx,
				input: { ...rejectInput, organizationId: null },
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
		});
		expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
	});

	it("does not act on a to-do of another organization", async () => {
		mocks.loadTodoForMutation.mockResolvedValue(null);

		await expect(
			mocks.captured.manageProposalLink({
				context: baseCtx,
				input: { ...rejectInput, todoId: "todo-elsewhere" },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.assertProjectPermission).not.toHaveBeenCalled();
	});

	it("refuses a to-do with no meeting", async () => {
		mocks.loadTodoForMutation.mockResolvedValue(manualTodo);

		await expect(
			mocks.captured.manageProposalLink({
				context: baseCtx,
				input: { ...rejectInput, todoId: manualTodo.id },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.dismissActionItemLink).not.toHaveBeenCalled();
	});
});
