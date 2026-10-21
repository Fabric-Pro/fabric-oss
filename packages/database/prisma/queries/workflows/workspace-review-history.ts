import { db, type Prisma, type WorkflowExecution } from "../../client";
import {
	assertWorkspaceWorkflowBindingWithin,
	type WorkspaceWorkflowRowGuard,
} from "./workspace-workflow-binding";

export type WorkspaceReviewHistoryRow = Pick<
	WorkflowExecution,
	"id" | "status" | "triggerType" | "startedAt" | "completedAt" | "duration"
> & {
	hasError: boolean;
	review: Prisma.JsonValue;
	frameId: string | null;
};

// Covers 20 type names of 128 UTF-16 units and a 512-unit assignee at up to 3 UTF-8 bytes per unit.
const REVIEW_SUMMARY_MAX_BYTES = 16_384;

/** Fetch at most 21 rows, each with at most 16 KiB of review JSON and a 128-character frame ID. */
export async function listWorkspaceReviewHistory(options: {
	binding: WorkspaceWorkflowRowGuard;
	nodeId: string;
	limit: number;
	offset: number;
}) {
	const { binding, nodeId, limit, offset } = options;
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 20 ||
		!Number.isInteger(offset) ||
		offset < 0 ||
		offset > 1000
	) {
		throw new RangeError("Review history pagination is out of bounds.");
	}
	return db.$transaction(
		async (tx) => {
			await assertWorkspaceWorkflowBindingWithin(tx, binding);
			const rows = await tx.$queryRaw<WorkspaceReviewHistoryRow[]>`
			SELECT e.id, e.status, e."triggerType", e."startedAt", e."completedAt", e.duration,
				e.error IS NOT NULL AS "hasError",
				CASE WHEN jsonb_typeof(e.output -> ${nodeId}) = 'object'
					AND octet_length(summary.review::text) <= ${REVIEW_SUMMARY_MAX_BYTES} THEN summary.review ELSE NULL END AS review,
				(SELECT value->>'frameId'
				 FROM jsonb_each(CASE WHEN jsonb_typeof(e.output) = 'object' THEN e.output ELSE '{}'::jsonb END)
				 WHERE jsonb_typeof(value->'frameId') = 'string'
					AND length(value->>'frameId') BETWEEN 1 AND 128
				 LIMIT 1) AS "frameId"
			FROM workflow_execution e
			CROSS JOIN LATERAL (
				SELECT jsonb_build_object(
					'counts', jsonb_build_object(
						'total', e.output -> ${nodeId} -> 'counts' -> 'total',
						'reviewed', e.output -> ${nodeId} -> 'counts' -> 'reviewed',
						'reused', e.output -> ${nodeId} -> 'counts' -> 'reused',
						'removed', e.output -> ${nodeId} -> 'counts' -> 'removed'),
					'forced', e.output -> ${nodeId} -> 'forced',
					'capture', jsonb_build_object('requirementsAsOf', e.output -> ${nodeId} -> 'capture' -> 'requirementsAsOf'),
					'selection', jsonb_build_object(
						'assignee', jsonb_build_object(
							'mode', e.output -> ${nodeId} -> 'selection' -> 'assignee' -> 'mode',
							'uniqueName', e.output -> ${nodeId} -> 'selection' -> 'assignee' -> 'uniqueName'),
						'workItemTypes', e.output -> ${nodeId} -> 'selection' -> 'workItemTypes')
				) AS review
			) summary
			WHERE e."workflowId" = ${binding.workflowId}
				AND e."userId" = ${binding.userId}
				AND e."organizationId" = ${binding.organizationId}
			ORDER BY e."startedAt" DESC, e.id DESC
			LIMIT ${limit + 1} OFFSET ${offset}
		`;
			const hasMore = rows.length > limit;
			return {
				executions: rows.slice(0, limit),
				hasMore,
				nextOffset: hasMore ? offset + limit : undefined,
			};
		},
		{ maxWait: 5_000, timeout: 10_000 },
	);
}
