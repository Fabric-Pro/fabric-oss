/**
 * Publishing Suggestion — Tenant-Tuple Assertion Activity
 *
 * The Task 9 workflow's FIRST activity, run before any collection or write.
 * Re-reads the Project + cycle fresh (never trusts workflow-input state,
 * which could be stale relative to a concurrent revocation/transfer) and
 * throws `PUBLISHING_TENANT_MISMATCH` non-retryably unless the full tenant
 * tuple matches:
 *
 * - F5 (cycle-ownership): the cycle's `projectId` must equal the input
 *   `projectId` — never touch another project's cycle even if every other
 *   field lines up.
 * - F2 (cycle-tuple): the cycle's OWN stored `organizationId`/`userId` must
 *   equal the input tuple — a projectId match alone is insufficient. After an
 *   org transfer an old-tenant cycle could still share the projectId; requiring
 *   the cycle's stored tuple to match the input closes that cross-tenant bleed.
 * - Org context: `Project.organizationId === organizationId`.
 * - Personal context: `organizationId === null && Project.userId === tenantUserId`.
 * - `Project.userId === actorUserId` — the actor must be the canonical
 *   project owner (holds for BOTH personal and org projects, since Fork-1
 *   sets the actor to `Project.userId`). For org projects the actor's
 *   current org-membership is revalidated inside the summarizer (Task 7)
 *   before model resolution.
 *
 * Fail-closed: any mismatch OR a missing Project/cycle row throws.
 */

import { db } from "@repo/database";
import { ApplicationFailure } from "@temporalio/common";
import {
	JOB_STEPS,
	jobEnsure,
	jobStep,
	seedJobSteps,
} from "../lib/job-progress";

export interface AssertTenantInput {
	cycleId: string; // F5: prove the cycle belongs to this project before any write
	projectId: string;
	organizationId: string | null;
	tenantUserId: string | null;
	actorUserId: string;
}

export async function assertProjectTenantTuple(
	input: AssertTenantInput,
): Promise<void> {
	const [project, cycle] = await Promise.all([
		db.project.findUnique({
			where: { id: input.projectId },
			select: { organizationId: true, userId: true },
		}),
		db.publishingSuggestionCycle.findUnique({
			where: { id: input.cycleId },
			select: { projectId: true, organizationId: true, userId: true },
		}),
	]);
	const org = input.organizationId ?? null;
	const ok =
		project != null &&
		cycle != null &&
		cycle.projectId === input.projectId && // F5: cycle-ownership — never touch another project's cycle
		(cycle.organizationId ?? null) === org && // F2: the cycle's OWN stored tuple must match the input tuple
		cycle.userId === input.tenantUserId && // F2: (not merely share the projectId)
		(project.organizationId ?? null) === org &&
		(org !== null || project.userId === input.tenantUserId) &&
		project.userId === input.actorUserId; // actor must be the canonical owner
	if (!ok) {
		throw ApplicationFailure.nonRetryable(
			"Project/tenant/cycle tuple mismatch — failing closed before collection",
			"PUBLISHING_TENANT_MISMATCH",
		);
	}

	// Job Hub (Fizzy #1850). AFTER the tuple check, never before: this file's
	// whole contract is that nothing is written until the tenant tuple is proven,
	// and a job row carries a tenancy. A rejected run therefore never marks
	// `collect` as running, so the close sweep records it `skipped` — collection
	// never started, which is the honest answer.
	//
	// This is the GUARANTEE that the dispatch's own write was only an
	// optimization for. `jobEnsure` resolves THIS workflow's id from the activity
	// context, so it adopts the dispatch's row when one exists and creates it
	// when the dispatch died — or lost its best-effort write — before making one.
	//
	// `reopenFailedWithClass: "TimedOut"` covers a second failure. The Job Hub
	// watchdog fails any row quiet for FABRIC_JOB_STALE_MINUTES (default 45), and
	// none of this workflow's activity proxies sets a scheduleToStartTimeout, so
	// a started execution can sit in a saturated task queue well past that. Every
	// later progress write targets RUNNING rows only, so without the reopen the
	// run would stay falsely red and then complete invisibly. The match is on
	// errorClass "TimedOut" alone, so a row failed for a real reason is never
	// resurrected.
	await jobEnsure({
		kind: "PUBLISHING_TOPIC_GENERATION",
		title: "Topic suggestions",
		projectId: input.projectId,
		userId: input.actorUserId,
		organizationId: input.organizationId,
		sourceId: null,
		steps: seedJobSteps([...JOB_STEPS.publishingTopicGeneration]),
		reopenFailedWithClass: "TimedOut",
	});
	await jobStep("collect", "running", { sourceId: null });
}
