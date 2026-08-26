import { db } from "../client";
import { getNotificationPreferences } from "./notification-preferences";

export interface ReportExecutionEmailContext {
	recipientEmail: string;
	instanceName: string;
	instanceId: string;
	organizationId: string | null;
	organizationSlug: string | null;
	status: "COMPLETED" | "FAILED";
}

/**
 * Claim-before-send gate for the one-shot report-run email.
 *
 * Reads the execution back (using its ACTUAL persisted status, not the
 * workflow's announced status), applies the preference and org-authorization
 * gates, then atomically claims `emailSentAt`. Returns the send context on a
 * fresh claim, or `null` to skip (any gate fails / status moved / already
 * claimed). The claim is NEVER released — at-most-once, best-effort.
 */
export async function claimReportExecutionEmail(input: {
	executionId: string;
	status: "COMPLETED" | "FAILED";
}): Promise<ReportExecutionEmailContext | null> {
	const { executionId, status } = input;

	const execution = await db.templateInstanceExecution.findUnique({
		where: { id: executionId },
		select: {
			status: true,
			userId: true,
			organizationId: true,
			instanceId: true,
			emailSentAt: true,
			instance: { select: { name: true } },
		},
	});
	if (!execution) {
		return null;
	}
	if (execution.status !== status) {
		return null;
	}
	if (execution.emailSentAt) {
		return null;
	}

	const user = await db.user.findUnique({
		where: { id: execution.userId },
		select: { email: true },
	});
	if (!user?.email) {
		return null;
	}

	const prefs = await getNotificationPreferences(execution.userId);
	if (!prefs.reportEmails) {
		return null;
	}

	// organizationSlug stays null ONLY for personal context. For org context it
	// is always a non-null slug — a slugless org cannot be linked (route is
	// /app/{slug}/...), so we skip rather than emit a wrong-context personal URL.
	let organizationSlug: string | null = null;
	if (execution.organizationId) {
		const member = await db.member.findUnique({
			where: {
				organizationId_userId: {
					organizationId: execution.organizationId,
					userId: execution.userId,
				},
			},
			select: { id: true },
		});
		if (!member) {
			return null; // removed member ⇒ skip (no leak), no claim
		}
		const org = await db.organization.findUnique({
			where: { id: execution.organizationId },
			select: { slug: true },
		});
		// Organization.slug is nullable (`String? @unique`). Without it we cannot
		// build a correct org deep link ⇒ skip BEFORE the claim (Codex [high]).
		if (!org?.slug) {
			return null;
		}
		organizationSlug = org.slug;
	}

	// Durable at-most-once claim — last step, never released.
	const claim = await db.templateInstanceExecution.updateMany({
		where: { id: executionId, emailSentAt: null, status },
		data: { emailSentAt: new Date() },
	});
	if (claim.count === 0) {
		return null;
	}

	return {
		recipientEmail: user.email,
		instanceName: execution.instance?.name ?? "your report",
		instanceId: execution.instanceId,
		organizationId: execution.organizationId,
		organizationSlug,
		status,
	};
}
