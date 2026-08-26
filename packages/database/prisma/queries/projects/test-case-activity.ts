/**
 * Per-case activity audit — the non-result half of a test
 * case's timeline. Result runs live in `TestResultEvent` (already surfaced in
 * the case editor); this records the edit history the UI merges with them:
 * creation (manual or AI-drafted), state / priority / title / steps / automation
 * changes, and feature-link changes.
 *
 * Every writer passes its transaction client so the activity row commits (or
 * rolls back) atomically with the change it describes — an activity must never
 * outlive a change that was rolled back, nor a change lack its activity.
 */

import { db } from "../../client";
import type { Prisma } from "../../generated/client";
import type {
	AutomationStatus,
	TestCaseActivityType,
	TestCasePriority,
	TestCaseState,
} from "../../generated/enums";

/** One activity event, shaped for the per-case timeline. */
export interface TestCaseActivityItem {
	id: string;
	type: TestCaseActivityType;
	actorUserId: string | null;
	actorName: string | null;
	actorLabel: string | null;
	fromValue: string | null;
	toValue: string | null;
	metadata: Prisma.JsonValue | null;
	occurredAt: string;
}

/** A Prisma transaction client, or the base client for a standalone write. */
type ActivityClient = Prisma.TransactionClient | typeof db;

export interface RecordTestCaseActivityInput {
	testCaseId: string;
	type: TestCaseActivityType;
	/** Fabric user who made the change; null for AI drafting / PM sync / system. */
	actorUserId?: string | null;
	/** Names a non-user actor (e.g. "AI draft") when actorUserId is null. */
	actorLabel?: string | null;
	fromValue?: string | null;
	toValue?: string | null;
	metadata?: Prisma.InputJsonValue;
}

/** Record one activity event. */
export async function recordTestCaseActivity(
	client: ActivityClient,
	input: RecordTestCaseActivityInput,
): Promise<void> {
	await client.testCaseActivity.create({
		data: {
			testCaseId: input.testCaseId,
			type: input.type,
			actorUserId: input.actorUserId ?? null,
			actorLabel: input.actorLabel ?? null,
			fromValue: input.fromValue ?? null,
			toValue: input.toValue ?? null,
			...(input.metadata !== undefined
				? { metadata: input.metadata }
				: {}),
		},
	});
}

/** Record several activity events at once (used by the update diff). No-op on []. */
export async function recordTestCaseActivities(
	client: ActivityClient,
	inputs: RecordTestCaseActivityInput[],
): Promise<void> {
	if (inputs.length === 0) {
		return;
	}
	await client.testCaseActivity.createMany({
		data: inputs.map((input) => ({
			testCaseId: input.testCaseId,
			type: input.type,
			actorUserId: input.actorUserId ?? null,
			actorLabel: input.actorLabel ?? null,
			fromValue: input.fromValue ?? null,
			toValue: input.toValue ?? null,
			...(input.metadata !== undefined
				? { metadata: input.metadata }
				: {}),
		})),
	});
}

/** The mutable fields the activity timeline tracks, before and after an update. */
export interface TestCaseActivitySnapshot {
	state: TestCaseState;
	priority: TestCasePriority;
	title: string;
	automationStatus: AutomationStatus;
	/** Number of steps (steps are replaced wholesale, so a count captures it). */
	stepCount: number;
}

/**
 * Diff two snapshots into the activity events an update produced. Only genuine
 * changes yield an event, so a no-op save writes nothing. Field order is stable
 * so a multi-field edit reads consistently in the timeline.
 */
export function diffTestCaseActivities(params: {
	testCaseId: string;
	actorUserId?: string | null;
	before: TestCaseActivitySnapshot;
	after: TestCaseActivitySnapshot;
}): RecordTestCaseActivityInput[] {
	const { testCaseId, actorUserId, before, after } = params;
	const events: RecordTestCaseActivityInput[] = [];
	const base = { testCaseId, actorUserId } as const;

	if (before.state !== after.state) {
		events.push({
			...base,
			type: "STATE_CHANGED",
			fromValue: before.state,
			toValue: after.state,
		});
	}
	if (before.priority !== after.priority) {
		events.push({
			...base,
			type: "PRIORITY_CHANGED",
			fromValue: before.priority,
			toValue: after.priority,
		});
	}
	if (before.title !== after.title) {
		events.push({
			...base,
			type: "RENAMED",
			fromValue: before.title,
			toValue: after.title,
		});
	}
	if (before.automationStatus !== after.automationStatus) {
		events.push({
			...base,
			type: "AUTOMATION_CHANGED",
			fromValue: before.automationStatus,
			toValue: after.automationStatus,
		});
	}
	if (before.stepCount !== after.stepCount) {
		events.push({
			...base,
			type: "STEPS_CHANGED",
			fromValue: String(before.stepCount),
			toValue: String(after.stepCount),
		});
	}
	return events;
}

/**
 * The activity history for one case, newest first — the edit half of the
 * timeline (the UI merges it with the result runs from `test_result_event`).
 *
 * Scoped through the parent case so a cross-project id resolves to nothing: the
 * caller has already been permission-gated on the project, and the case is
 * re-checked against `(id, projectId)` here so the events can only be read for a
 * case that genuinely lives in that project.
 *
 * Offset-paginated and it returns `total`, so the panel can show the newest few
 * and still say honestly how many there are — a truncated list that looks
 * complete is worse than a short one that says so.
 */
export async function listTestCaseActivity(input: {
	projectId: string;
	testCaseId: string;
	limit?: number;
	offset?: number;
}): Promise<{ items: TestCaseActivityItem[]; total: number }> {
	const owned = await db.testCase.findFirst({
		where: { id: input.testCaseId, projectId: input.projectId },
		select: { id: true },
	});
	if (!owned) {
		return { items: [], total: 0 };
	}
	const where = { testCaseId: input.testCaseId };
	const [rows, total] = await Promise.all([
		db.testCaseActivity.findMany({
			where,
			// `id` breaks ties, and ties are the common case here: one save
			// writes its state / priority / title / steps / automation events
			// in a single createMany, so they all carry the identical
			// `occurredAt`. Without a second sort key Postgres may order tied
			// rows differently per query, and under offset paging that drops
			// or repeats a row at the page boundary.
			orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
			take: input.limit ?? 50,
			skip: input.offset ?? 0,
			include: { actorUser: { select: { name: true } } },
		}),
		db.testCaseActivity.count({ where }),
	]);
	return {
		items: rows.map((row) => ({
			id: row.id,
			type: row.type,
			actorUserId: row.actorUserId,
			actorName: row.actorUser?.name ?? null,
			actorLabel: row.actorLabel,
			fromValue: row.fromValue,
			toValue: row.toValue,
			metadata: row.metadata,
			occurredAt: row.occurredAt.toISOString(),
		})),
		total,
	};
}
