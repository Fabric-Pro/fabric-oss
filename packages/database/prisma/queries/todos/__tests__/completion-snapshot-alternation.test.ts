/**
 * Alternating between the two surfaces that write one completion (#2340).
 *
 * `ProjectMeetingActionItem.completedAt` is written by the meeting digest
 * (`setActionItemCompletion`) and by the To Do page (`setTodoCompletion`), and
 * `TodoItem.lastKnownCompletedAt` is a snapshot of it — the only record that
 * survives the re-extraction which eventually reworods the item and orphans the
 * binding. Both surfaces are reachable by the same people: the digest needs
 * `PROJECT_READ`, the To Do page needs organization membership plus project
 * reach. Alternating between them is ordinary use, not an edge case.
 *
 * The other tests in this folder mock the delegates and assert which row each
 * write addresses. This one runs both writers against ONE tiny in-memory store,
 * because the property at stake is not the shape of a single call — it is what
 * the two of them leave behind when a person uses them in turn:
 *
 *  - complete in the digest, then reword: the page must still say "you did this
 *    once" (before this module existed, the snapshot was never written and the
 *    orphan offered work the person had already finished);
 *  - complete on the page, reopen in the digest, then reword: the page must NOT
 *    claim a completion the person explicitly took back.
 *
 * Run with:
 *   pnpm --filter @repo/database test completion-snapshot-alternation
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "org-acme";
const PROJECT = "project-1";
const TRANSCRIPT = "transcript-1";
const PAGE_USER = "user-dana";
const DIGEST_USER = "user-remy";
const T1 = new Date("2026-09-14T09:00:00.000Z");
const T2 = new Date("2026-09-15T09:00:00.000Z");

type ActionItemRow = {
	id: string;
	transcriptId: string;
	orderIndex: number;
	text: string;
	itemKey: string | null;
	completedAt: Date | null;
	completedById: string | null;
	organizationId: string | null;
};

type TodoRow = {
	id: string;
	source: "MEETING_DIGEST" | "MANUAL";
	transcriptId: string | null;
	itemKey: string | null;
	occurrenceIndex: number | null;
	itemTextSnapshot: string | null;
	title: string | null;
	projectId: string | null;
	userId: string | null;
	organizationId: string | null;
	assigneeUserId: string | null;
	assigneeContactId: string | null;
	assignedManually: boolean;
	snoozedUntil: Date | null;
	completedAt: Date | null;
	completedById: string | null;
	lastKnownCompletedAt: Date | null;
	sourceDate: Date;
	createdAt: Date;
	updatedAt: Date;
};

const store = vi.hoisted(() => ({
	actionItems: [] as Array<Record<string, unknown>>,
	todos: [] as Array<Record<string, unknown>>,
	/** Which project each transcript belongs to — the relation the scope uses. */
	transcriptProject: new Map<string, string>(),
}));

vi.mock("../../../client", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;

	// A `where` as these modules write them: scalar equality plus the one
	// nested relation (`transcript: { projectId }`). `undefined` means "no
	// filter", exactly as Prisma reads it.
	const matches = (
		row: Record<string, unknown>,
		where: Record<string, unknown>,
	): boolean => {
		for (const [column, expected] of Object.entries(where)) {
			if (expected === undefined) {
				continue;
			}
			if (column === "transcript") {
				const { projectId } = expected as { projectId: string };
				const transcriptId = row.transcriptId as string | null;
				if (
					transcriptId === null ||
					store.transcriptProject.get(transcriptId) !== projectId
				) {
					return false;
				}
				continue;
			}
			if (row[column] !== expected) {
				return false;
			}
		}
		return true;
	};

	const delegate = (rows: Array<Record<string, unknown>>) => ({
		findFirst: async ({ where }: { where: Record<string, unknown> }) =>
			rows.find((row) => matches(row, where)) ?? null,
		findMany: async ({ where }: { where: Record<string, unknown> }) =>
			rows
				.filter((row) => matches(row, where))
				.sort(
					(a, b) =>
						(a.orderIndex as number) - (b.orderIndex as number),
				),
		updateMany: async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			const hit = rows.filter((row) => matches(row, where));
			for (const row of hit) {
				Object.assign(row, data);
			}
			return { count: hit.length };
		},
	});

	const client = {
		projectMeetingActionItem: delegate(store.actionItems),
		todoItem: delegate(store.todos),
		$transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(client),
	};

	return { ...actual, db: client };
});

const { computeTodoItemKey, bindActionItemsToTodos } = await import(
	"../bind-action-items"
);
const { setActionItemCompletion } = await import("../complete-action-item");
const { setTodoCompletion } = await import("../mutate-todos");

const ORIGINAL_TEXT = "Send the revised scope to the client";
const REWORDED_TEXT = "Send the revised scope document to the client";

function seed(): { item: ActionItemRow; todo: TodoRow } {
	const itemKey = computeTodoItemKey(ORIGINAL_TEXT);
	const item: ActionItemRow = {
		id: "item-a",
		transcriptId: TRANSCRIPT,
		orderIndex: 0,
		text: ORIGINAL_TEXT,
		itemKey,
		completedAt: null,
		completedById: null,
		organizationId: ORG,
	};
	const todo: TodoRow = {
		id: "todo-a",
		source: "MEETING_DIGEST",
		transcriptId: TRANSCRIPT,
		itemKey,
		occurrenceIndex: 0,
		itemTextSnapshot: ORIGINAL_TEXT,
		title: null,
		projectId: PROJECT,
		userId: "user-transcript-owner",
		organizationId: ORG,
		assigneeUserId: null,
		assigneeContactId: null,
		assignedManually: false,
		snoozedUntil: null,
		completedAt: null,
		completedById: null,
		lastKnownCompletedAt: null,
		sourceDate: T1,
		createdAt: T1,
		updatedAt: T1,
	};
	store.actionItems.push(item as unknown as Record<string, unknown>);
	store.todos.push(todo as unknown as Record<string, unknown>);
	store.transcriptProject.set(TRANSCRIPT, PROJECT);
	return { item, todo };
}

/**
 * Re-extraction: the items are deleted and recreated, and the new wording
 * normalizes to a different key — which is precisely when the binding stops
 * resolving and the snapshot becomes the only history the row has.
 */
function reword(): ActionItemRow {
	store.actionItems.length = 0;
	const item: ActionItemRow = {
		id: "item-b",
		transcriptId: TRANSCRIPT,
		orderIndex: 0,
		text: REWORDED_TEXT,
		itemKey: computeTodoItemKey(REWORDED_TEXT),
		completedAt: null,
		completedById: null,
		organizationId: ORG,
	};
	store.actionItems.push(item as unknown as Record<string, unknown>);
	return item;
}

/** The page's own rule, `wasPreviouslyCompleted`, over a stored row. */
function pageClaimsItWasCompletedOnce(todo: TodoRow): boolean {
	const isCompleted = todo.completedAt !== null;
	return !isCompleted && Boolean(todo.lastKnownCompletedAt);
}

beforeEach(() => {
	store.actionItems.length = 0;
	store.todos.length = 0;
	store.transcriptProject.clear();
});

describe("the digest completes, then the wording changes", () => {
	it("leaves the orphaned row able to say it was done", async () => {
		const { todo } = seed();

		await setActionItemCompletion({
			actionItemId: "item-a",
			projectId: PROJECT,
			organizationId: ORG,
			userId: DIGEST_USER,
			completed: true,
			now: T1,
		});

		// The truth landed on the action item, and the snapshot beside it.
		expect(store.actionItems[0]?.completedAt).toEqual(T1);
		expect(todo.lastKnownCompletedAt).toEqual(T1);
		// The bound row still holds no completion of its own — the invariant
		// the read's COALESCE depends on.
		expect(todo.completedAt).toBeNull();

		const live = reword();
		const binding = bindActionItemsToTodos({
			actionItems: [live],
			todos: [todo],
		});

		expect(binding.orphaned).toEqual([todo]);
		// Before the digest maintained the snapshot this was `false`: the page
		// showed a finished commitment as open work and offered it back.
		expect(pageClaimsItWasCompletedOnce(todo)).toBe(true);
	});
});

describe("the page completes, the digest reopens, then the wording changes", () => {
	it("does not let the orphaned row claim a completion that was taken back", async () => {
		const { todo } = seed();

		await setTodoCompletion({
			todo,
			organizationId: ORG,
			completed: true,
			userId: PAGE_USER,
			now: T1,
		});
		expect(store.actionItems[0]?.completedAt).toEqual(T1);
		expect(todo.lastKnownCompletedAt).toEqual(T1);

		// The same people reach both surfaces, and the digest is the older and
		// busier one. Reopening there is the write that used to leave the
		// snapshot behind.
		await setActionItemCompletion({
			actionItemId: "item-a",
			projectId: PROJECT,
			organizationId: ORG,
			userId: DIGEST_USER,
			completed: false,
			now: T2,
		});

		expect(store.actionItems[0]?.completedAt).toBeNull();
		expect(todo.lastKnownCompletedAt).toBeNull();
		expect(todo.completedAt).toBeNull();

		const live = reword();
		const binding = bindActionItemsToTodos({
			actionItems: [live],
			todos: [todo],
		});

		expect(binding.orphaned).toEqual([todo]);
		expect(pageClaimsItWasCompletedOnce(todo)).toBe(false);
	});
});

describe("a digest write with nothing bound to it", () => {
	it("completes the action item and touches no to-do", async () => {
		const { item } = seed();
		store.todos.length = 0;

		const result = await setActionItemCompletion({
			actionItemId: item.id,
			projectId: PROJECT,
			organizationId: ORG,
			userId: DIGEST_USER,
			completed: true,
			now: T1,
		});

		expect(result).toEqual({
			matched: true,
			completedAt: T1,
			snapshotWrites: 0,
		});
		expect(store.actionItems[0]?.completedAt).toEqual(T1);
	});

	it("refuses an action item reached through another project", async () => {
		seed();

		const result = await setActionItemCompletion({
			actionItemId: "item-a",
			projectId: "project-elsewhere",
			organizationId: ORG,
			userId: DIGEST_USER,
			completed: true,
			now: T1,
		});

		expect(result.matched).toBe(false);
		// Neither half of the pair moved.
		expect(store.actionItems[0]?.completedAt).toBeNull();
		expect(store.todos[0]?.lastKnownCompletedAt).toBeNull();
	});
});
