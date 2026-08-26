import {
	bulkMutateTestCases,
	getTestCase,
	TEST_CASE_STATES,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { enqueueTestCaseAutoSync } from "../../lib/enqueue-test-case-auto-sync";
import { removeTestCaseContext } from "../../lib/test-case-context";
import { testCaseSelectionSchema } from "../../lib/test-case-selection";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";
import { mirrorTestCaseToContext } from "./sync-context";

/**
 * Bulk test-case operations over EITHER an explicit id list or a filter.
 *
 * The filter mode is what makes "Select all N matching" honest: with
 * 100-per-page pagination the browser only ever holds the loaded ids, so a
 * client-driven fan-out silently applied to the first page and no further. Here
 * the server re-resolves the matching set from the same predicate the list
 * rendered (`buildTestCaseWhere` backs both the list and the resolver), so the
 * action covers every match. It also collapses N HTTP mutations into one
 * transaction, so a partial failure can't leave half the set applied.
 *
 * Split in two by PERMISSION, not by taste: destructive deletes require
 * `TEST_CASE_DELETE` and must not ride in on `TEST_CASE_UPDATE` rights. The
 * middleware asserts one permission per procedure, so DELETE gets its own.
 */

/**
 * How many per-case side effects run at once. Each starts a Temporal workflow;
 * firing thousands at once would swamp the client and the worker.
 */
const SIDE_EFFECT_CONCURRENCY = 8;

// Shared with the run-dispatch path — see `lib/test-case-selection`. Kept in one
// place so a bulk edit and a run launched from the same list cannot disagree
// about which cases "all N matching" names.
const selectionSchema = testCaseSelectionSchema;

const updateOperationSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("SET_STATE"),
		state: z.enum(TEST_CASE_STATES),
	}),
	z.object({
		type: z.literal("SET_RESULT"),
		result: z.enum(["PASSED", "FAILED", "BLOCKED"]),
		note: z.string().max(1000).nullable().optional(),
	}),
	z.object({ type: z.literal("ADD_TO_PLAN"), planId: z.string() }),
]);

/**
 * Run `fn` over `items` with at most `limit` in flight. Per-item rejections are
 * contained: RAG mirroring is best-effort by construction and must never fail
 * the write it accompanies.
 */
async function mapWithConcurrency<T>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (cursor < items.length) {
				const item = items[cursor++];
				await fn(item).catch(() => undefined);
			}
		},
	);
	await Promise.all(workers);
}

export const bulkMutateTestCasesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/bulk",
		tags: ["Projects", "Test Cases"],
		summary: "Apply a bulk operation to test cases by id or by filter",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			selection: selectionSchema,
			operation: updateOperationSchema,
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates project
		// access; the selection is re-scoped to the project in the query layer, so
		// a foreign id silently drops rather than being mutated.
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const { affected, ids } = await bulkMutateTestCases({
			projectId: input.projectId,
			selection: input.selection,
			operation: input.operation,
			actingUserId: user.id,
		});

		// Side effects, faithful to the single-case procedures:
		//  - SET_STATE → re-mirror (the embedded body carries "State: X") and
		//    re-apply the PM auto-sync gate, exactly as `update-test-case` does.
		//  - SET_RESULT / ADD_TO_PLAN → nothing. Neither run results nor plan
		//    membership appear in `buildTestCaseContextContent`, and neither
		//    `record-result` nor `add-case-to-plan` mirrors or enqueues. Doing
		//    nothing here is faithful, not an omission.
		if (input.operation.type === "SET_STATE") {
			await mapWithConcurrency(
				ids,
				SIDE_EFFECT_CONCURRENCY,
				async (id) => {
					const detail = await getTestCase({
						id,
						projectId: input.projectId,
					});
					if (!detail) {
						return;
					}
					await mirrorTestCaseToContext(detail, {
						userId: user.id,
						organizationId,
					});
					if (detail.externalId && detail.pmAutoSyncEnabled) {
						void enqueueTestCaseAutoSync({
							projectId: input.projectId,
							testCaseId: id,
							userId: user.id,
						});
					}
				},
			);
		}

		return { affected };
	});

export const bulkDeleteTestCasesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_DELETE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/bulk-delete",
		tags: ["Projects", "Test Cases"],
		summary: "Delete test cases by id or by filter",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			selection: selectionSchema,
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_DELETE) gates project
		// access — deleting is not reachable with update-only rights.
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const { affected, contextIds } = await bulkMutateTestCases({
			projectId: input.projectId,
			selection: input.selection,
			operation: { type: "DELETE" },
			actingUserId: user.id,
		});

		// Tear down the mirrored RAG contexts so deleted cases stop surfacing to
		// the AI (mirrors `delete-test-case`). The ids were captured inside the
		// delete transaction, before `deletedAt` hid the rows.
		await mapWithConcurrency(
			contextIds,
			SIDE_EFFECT_CONCURRENCY,
			async (contextId) =>
				removeTestCaseContext({
					contextId,
					projectId: input.projectId,
					userId: user.id,
					organizationId,
				}),
		);

		return { affected };
	});
