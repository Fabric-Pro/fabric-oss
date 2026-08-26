import type { NewsletterChatChannel } from "@repo/database";
import {
	coerceDeliveryDestination,
	coerceDetailLevel,
	createOrGetNewsletterSend,
	isScheduledNewsletterActorValid,
	reclaimStaleReviewSends,
	setNewsletterSendWorkflowId,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { getTemporalClient } from "../../client";
import type { GenerateAndSendNewsletterInput } from "../../workflows/generate-and-send-newsletter";
import type { DueNewsletterProject } from "./find-due-newsletter-projects";

export async function dispatchNewsletterSendActivity(
	p: DueNewsletterProject,
): Promise<void> {
	heartbeat(`dispatchNewsletterSend: ${p.projectId}`);
	// Re-validate the actor immediately before creating the send / starting the
	// workflow. findDueNewsletterProjectsActivity already checked, but the hourly
	// sweep and this dispatch are separate steps — an admin removed in between
	// must not start a generation that would resolve their personal AI provider.
	// (The AI-resolving activity re-checks once more right before the LLM call.)
	if (
		!(await isScheduledNewsletterActorValid(
			p.triggeredByUserId,
			p.organizationId,
			p.userId,
		))
	) {
		logger.warn(
			"[Newsletter] Skipping dispatch: configuring admin is no longer a valid member of the organization",
			{
				projectId: p.projectId,
				organizationId: p.organizationId,
				triggeredByUserId: p.triggeredByUserId,
			},
		);
		return;
	}
	// Free the active-send slot if it is wedged by a stale review send:
	// an abandoned held draft (→ EXPIRED) or a dead approved send whose workflow
	// never finalized (→ FAILED). Never advances lastSentAt. (Fizzy 1869 / Codex.)
	const reclaimed = await reclaimStaleReviewSends(p.projectId);
	if (reclaimed.expiredDraftId || reclaimed.failedApprovedId) {
		logger.warn("[Newsletter] reclaimed stale review send", {
			projectId: p.projectId,
			expiredDraftId: reclaimed.expiredDraftId,
			failedApprovedId: reclaimed.failedApprovedId,
		});
	}
	const { send, created } = await createOrGetNewsletterSend({
		projectId: p.projectId,
		organizationId: p.organizationId,
		userId: p.userId,
		dedupeKey: p.dedupeKey,
		trigger: "SCHEDULED",
		timeWindowStart: new Date(p.timeWindowStart),
		timeWindowEnd: new Date(p.timeWindowEnd),
		triggeredByUserId: p.triggeredByUserId,
		detailLevel: p.detailLevel,
		deliveryDestination: p.deliveryDestination,
		requireApproval: p.requireApproval,
		chatChannels: p.chatChannels,
	});
	// Only skip TERMINAL reused rows (already ran this period). A reused PENDING
	// row is ALWAYS (re)started — WITH or WITHOUT a temporalWorkflowId — via the
	// deterministic `newsletter-send-<sendId>` workflow id. This is the recovery
	// model: a still-running workflow → WorkflowExecutionAlreadyStartedError
	// (safe no-op below); a started-but-unfinalized / closed one → restarts with
	// the SAME sendId, so the preserved NewsletterDelivery rows + stable provider
	// Idempotency-Key dedup already-sent recipients (no double-mail) while the
	// unsent ones are re-attempted. We must NOT skip on temporalWorkflowId: a row
	// that recorded an id but whose workflow then died would otherwise be
	// stranded PENDING forever.
	if (!created && send.status !== "PENDING") {
		return;
	}

	const args: GenerateAndSendNewsletterInput = {
		sendId: send.id,
		projectId: p.projectId,
		organizationId: p.organizationId,
		userId: p.userId,
		triggeredByUserId: p.triggeredByUserId,
		projectName: p.projectName,
		trigger: "SCHEDULED",
		timeWindowStart: p.timeWindowStart,
		timeWindowEnd: p.timeWindowEnd,
		detailLevel: coerceDetailLevel(send.detailLevel),
		deliveryDestination: coerceDeliveryDestination(
			send.deliveryDestination,
		),
		chatChannels: (send.chatChannels ?? []) as NewsletterChatChannel[],
		requireApproval: send.requireApproval,
	};
	const workflowId = `newsletter-send-${send.id}`;

	let handle: Awaited<
		ReturnType<
			Awaited<ReturnType<typeof getTemporalClient>>["workflow"]["start"]
		>
	>;
	try {
		const client = await getTemporalClient();
		handle = await client.workflow.start(
			"generateAndSendNewsletterWorkflow",
			{
				taskQueue: "fabric-worker",
				workflowId,
				args: [args],
				workflowExecutionTimeout: "15m",
			},
		);
	} catch (err) {
		// The deterministic workflowId already runs (a concurrent dispatch won the
		// race) — idempotent, nothing to do.
		if (err instanceof WorkflowExecutionAlreadyStartedError) {
			return;
		}
		// Any other start failure: leave the row PENDING (do NOT mark FAILED) and
		// re-throw so Temporal retries this activity. A later attempt — this
		// retry, or the next due tick — reuses the same PENDING row + deterministic
		// workflowId and restarts it (the restart-same-id recovery model). There
		// is no reclaim/backstop sweep by design.
		throw err;
	}

	// The workflow is alive and will finalize the row regardless. Persist the
	// workflowId best-effort; if persistence fails, NEVER mark the row FAILED —
	// that would race the live workflow.
	try {
		await setNewsletterSendWorkflowId(send.id, handle.workflowId);
	} catch (e) {
		logger.warn(
			"[Newsletter] failed to persist workflowId; workflow is running",
			{
				sendId: send.id,
				error: e instanceof Error ? e.message : String(e),
			},
		);
	}
}
