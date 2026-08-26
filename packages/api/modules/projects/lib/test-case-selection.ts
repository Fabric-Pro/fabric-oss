/**
 * What "the cases I mean" looks like on the wire.
 *
 * Shared because two different verbs act on the same set — bulk editing them,
 * and starting a run over them — and they must not disagree about what "all N
 * matching" resolves to. They previously did: the bulk path took a predicate
 * while the run path took the ticked-id list, which "select all matching"
 * deliberately empties, so the widest selection the list offered dispatched
 * nothing and the Run button went dead with no explanation.
 *
 * The filter mirrors the list's own query fields, and the database resolves it
 * with the same `buildTestCaseWhere` the list uses, so a selection can never
 * name a set the list would not have shown.
 */

import { TEST_CASE_STATES } from "@repo/database";
import { z } from "zod";

const testCaseFilterSchema = z.object({
	search: z.string().optional(),
	state: z.enum(TEST_CASE_STATES).optional(),
	priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
	tag: z.string().optional(),
	linkedStoryId: z.string().optional(),
	planId: z.string().optional(),
	automationStatus: z
		.enum(["NOT_AUTOMATED", "PLANNED", "AUTOMATED"])
		.optional(),
	currentResult: z
		.enum(["NOT_RUN", "PASSED", "FAILED", "BLOCKED", "SKIPPED"])
		.optional(),
	externalLinked: z.boolean().optional(),
});

/**
 * `ids` is capped because it is a literal request payload; `filter` is not —
 * resolving it to "every matching case" is the entire point, and it costs one
 * indexed query regardless of the count. A caller that must bound the RESULT
 * (a run holds a browser session per case) bounds it after resolving, where it
 * can say how many were matched.
 */
export const testCaseSelectionSchema = z.discriminatedUnion("mode", [
	z.object({
		mode: z.literal("ids"),
		ids: z.array(z.string()).min(1).max(500),
	}),
	z.object({ mode: z.literal("filter"), filter: testCaseFilterSchema }),
]);
