/**
 * Bulk operations over a selection of Test Cases — by explicit ids, or by filter
 * ("select all N matching").
 *
 * Its own module because it is the one write path that fans out across an
 * unbounded set rather than a single case: every operation resolves its targets
 * server-side and applies in ONE transaction. It compiles its `filter`-mode
 * predicate with the list's {@link buildTestCaseWhere}, so a bulk action and the
 * list it was launched from cannot drift apart. Sibling of `test-cases.ts`
 * behind the same barrel.
 */

import {
	db,
	type Prisma,
	type TestCaseState,
	type TestResult,
} from "../../client";
import { recordTestCaseActivities } from "./test-case-activity";
import { buildTestCaseWhere, type TestCaseFilter } from "./test-case-list";
import { resolveActorLabel } from "./test-case-results";

// ---------------------------------------------------------------------------
// Bulk operations (by explicit ids, or by filter — "select all N matching")
// ---------------------------------------------------------------------------

/**
 * WHICH cases a bulk operation applies to.
 *
 * `filter` is the "select all N matching" mode: the server re-resolves the
 * matching set from the same predicate the list rendered, so the action covers
 * every match — not just the ids the client had paged in. That distinction is
 * the whole point: with 100-per-page pagination an id list can only ever name
 * the loaded rows.
 */
export type TestCaseSelection =
	| { mode: "ids"; ids: string[] }
	| { mode: "filter"; filter: TestCaseFilter };

/** WHAT a bulk operation does to the selected cases. */
export type TestCaseBulkOperation =
	| { type: "SET_STATE"; state: TestCaseState }
	| { type: "SET_RESULT"; result: TestResult; note?: string | null }
	| { type: "ADD_TO_PLAN"; planId: string; section?: string | null }
	| { type: "DELETE" };

export interface BulkMutateTestCasesInput {
	projectId: string;
	selection: TestCaseSelection;
	operation: TestCaseBulkOperation;
	/** Fabric user performing the action (result provenance + audit). */
	actingUserId: string;
}

/**
 * Resolve a {@link TestCaseSelection} to the concrete, live case ids it names.
 *
 * Both modes are re-scoped to `projectId` + `deletedAt: null` in the DB, so an
 * id from another project (or an already-deleted case) silently drops out
 * rather than being mutated — the caller's id list is never trusted as
 * authorization.
 */
async function resolveTestCaseSelection(
	tx: Prisma.TransactionClient,
	projectId: string,
	selection: TestCaseSelection,
): Promise<string[]> {
	const where: Prisma.TestCaseWhereInput =
		selection.mode === "ids"
			? { projectId, deletedAt: null, id: { in: selection.ids } }
			: buildTestCaseWhere(projectId, selection.filter);
	const rows = await tx.testCase.findMany({ where, select: { id: true } });
	return rows.map((r) => r.id);
}

/**
 * The live case ids a selection names, without mutating anything.
 *
 * Exists so starting a RUN from "select all N matching" resolves the same
 * predicate the bulk actions resolve. Before this, the run path received the
 * ticked-id list — which "select all matching" deliberately empties, because the
 * intent travels as a predicate — so the widest selection the list offers
 * dispatched nothing and the Run button simply went dead.
 *
 * Not wrapped in a transaction: the caller is reading, and the ids are re-checked
 * against the project on the write that follows.
 */
export async function listTestCaseIdsForSelection(input: {
	projectId: string;
	selection: TestCaseSelection;
}): Promise<string[]> {
	return resolveTestCaseSelection(db, input.projectId, input.selection);
}

export interface BulkMutateTestCasesResult {
	/** How many cases the operation actually changed. */
	affected: number;
	/** The live case ids the selection resolved to. */
	ids: string[];
	/**
	 * For DELETE: the mirrored `ProjectContext` ids of the deleted cases, read
	 * inside the transaction BEFORE the soft-delete lands (afterwards the rows
	 * are invisible to the `deletedAt: null` resolver). The caller tears these
	 * down so a deleted case stops surfacing to the AI. Empty for every other
	 * operation.
	 */
	contextIds: string[];
}

/**
 * Apply one bulk operation to a selection of cases in a single transaction, and
 * return how many cases it actually affected.
 *
 * This replaces a per-id fan-out from the browser: at "select all matching"
 * scale that would be thousands of round-trips, each its own transaction, with
 * partial failure leaving the set half-applied.
 */
export async function bulkMutateTestCases(
	input: BulkMutateTestCasesInput,
): Promise<BulkMutateTestCasesResult> {
	return db.$transaction(async (tx) => {
		const ids = await resolveTestCaseSelection(
			tx,
			input.projectId,
			input.selection,
		);
		if (ids.length === 0) {
			return { affected: 0, ids: [], contextIds: [] };
		}

		switch (input.operation.type) {
			case "SET_STATE": {
				const nextState = input.operation.state;
				// Read prior states so the activity timeline records the real
				// transition per case — and so a bulk set to a state a case is
				// already in records nothing for that case.
				const before = await tx.testCase.findMany({
					where: { id: { in: ids } },
					select: { id: true, state: true },
				});
				const { count } = await tx.testCase.updateMany({
					where: { id: { in: ids } },
					data: { state: nextState },
				});
				await recordTestCaseActivities(
					tx,
					before
						.filter((c) => c.state !== nextState)
						.map((c) => ({
							testCaseId: c.id,
							type: "STATE_CHANGED" as const,
							actorUserId: input.actingUserId,
							fromValue: c.state,
							toValue: nextState,
						})),
				);
				return { affected: count, ids, contextIds: [] };
			}
			case "SET_RESULT": {
				// Mirrors `resetProjectTestResults`: append one event per case
				// (history is append-only) and refresh the denormalized current
				// in the same transaction, so the list and the per-case history
				// can never diverge.
				const label = await resolveActorLabel(tx, {
					changedByUserId: input.actingUserId,
				});
				const now = new Date();
				const { result, note } = input.operation;
				await tx.testResultEvent.createMany({
					data: ids.map((id) => ({
						testCaseId: id,
						result,
						source: "MANUAL" as const,
						occurredAt: now,
						changedByUserId: input.actingUserId,
						note: note ?? null,
					})),
				});
				const { count } = await tx.testCase.updateMany({
					where: { id: { in: ids } },
					data: {
						currentResult: result,
						lastRunAt: now,
						lastRunSource: "MANUAL",
						lastRunByLabel: label,
					},
				});
				return { affected: count, ids, contextIds: [] };
			}
			case "ADD_TO_PLAN": {
				// Re-scope the PLAN to this project, exactly as the cases were.
				// The selection resolver only vouches for the case ids; the plan
				// id arrives straight from the request, so without this a caller
				// with rights on project A could file A's cases into project B's
				// plan — where B's plan detail would then render them. Mirrors
				// the guard the single-case add path already performs.
				const plan = await tx.testPlan.findFirst({
					where: {
						id: input.operation.planId,
						projectId: input.projectId,
						deletedAt: null,
					},
					select: { id: true },
				});
				if (!plan) {
					return { affected: 0, ids, contextIds: [] };
				}
				// Cases already in the plan must not be re-added — (planId,
				// testCaseId) is UNIQUE, so a blind createMany would abort the
				// whole batch on the first overlap. Skipping them also makes the
				// action idempotent.
				const existing = await tx.testPlanCase.findMany({
					where: {
						planId: input.operation.planId,
						testCaseId: { in: ids },
					},
					select: { testCaseId: true },
				});
				const present = new Set(existing.map((e) => e.testCaseId));
				const toAdd = ids.filter((id) => !present.has(id));
				if (toAdd.length === 0) {
					return { affected: 0, ids, contextIds: [] };
				}
				const last = await tx.testPlanCase.findFirst({
					where: { planId: input.operation.planId },
					orderBy: { order: "desc" },
					select: { order: true },
				});
				const base = last?.order ?? 0;
				const { planId, section } = input.operation;
				const { count } = await tx.testPlanCase.createMany({
					data: toAdd.map((testCaseId, index) => ({
						planId,
						testCaseId,
						section: section ?? null,
						order: base + index + 1,
					})),
				});
				return { affected: count, ids, contextIds: [] };
			}
			case "DELETE": {
				// Read the mirrored context ids BEFORE the soft-delete: once
				// `deletedAt` is stamped the rows drop out of every live query,
				// and the contexts would be orphaned — leaving deleted cases
				// visible to the project AI.
				const mirrored = await tx.testCase.findMany({
					where: { id: { in: ids }, contextId: { not: null } },
					select: { contextId: true },
				});
				const { count } = await tx.testCase.updateMany({
					where: { id: { in: ids } },
					data: { deletedAt: new Date() },
				});
				return {
					affected: count,
					ids,
					contextIds: mirrored
						.map((m) => m.contextId)
						.filter((id): id is string => id !== null),
				};
			}
			default: {
				const exhaustive: never = input.operation;
				return exhaustive;
			}
		}
	});
}
