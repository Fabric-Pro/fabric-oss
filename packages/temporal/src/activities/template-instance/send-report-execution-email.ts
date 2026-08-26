import { claimReportExecutionEmail } from "@repo/database";
import { isMailConfigured, sendEmail } from "@repo/mail";
import { getBaseUrl } from "@repo/utils";
import { activityLogger } from "../lib/activity-logger";

/**
 * Send the run owner a completion/failure email for a report execution.
 *
 * Thin wrapper: a pre-claim config guard, then the
 * `@repo/database` gate+claim helper, then the provider send. The claim is
 * taken inside the helper and never released; a send failure drops the email.
 */
export async function sendReportExecutionEmail(input: {
	executionId: string;
	status: "COMPLETED" | "FAILED";
}): Promise<void> {
	// Pre-claim config guard: throwing here is retry-safe (no claim taken).
	if (!isMailConfigured()) {
		throw new Error(
			"Mail is not configured (RESEND_API_KEY missing); retrying report email.",
		);
	}

	const ctx = await claimReportExecutionEmail(input);
	if (!ctx) {
		return; // gate failed / already claimed / skipped
	}

	// getBaseUrl() returns the env value verbatim — strip any trailing slash so
	// APP_URL="https://fabric.pro/" doesn't produce "https://fabric.pro//app/..." (Codex [low]).
	const baseUrl = getBaseUrl().replace(/\/+$/, "");
	const orgPrefix = ctx.organizationSlug
		? `/app/${ctx.organizationSlug}`
		: "/app";
	const tab = ctx.status === "COMPLETED" ? "overview" : "history";
	const url = `${baseUrl}${orgPrefix}/report-templates/instances/${ctx.instanceId}?tab=${tab}`;
	const idempotencyKey = `report-email-${input.executionId}-${input.status}`;

	const ok =
		ctx.status === "COMPLETED"
			? await sendEmail({
					to: ctx.recipientEmail,
					templateId: "reportExecutionReady",
					idempotencyKey,
					context: { instanceName: ctx.instanceName, url },
				})
			: await sendEmail({
					to: ctx.recipientEmail,
					templateId: "reportExecutionFailed",
					idempotencyKey,
					context: { instanceName: ctx.instanceName, url },
				});

	if (!ok) {
		// Claim already taken (never released) ⇒ drop, best-effort.
		activityLogger.warn("Report execution email failed to send", {
			executionId: input.executionId,
			status: input.status,
		});
	}
}
