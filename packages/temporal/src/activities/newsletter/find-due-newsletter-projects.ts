import type {
	NewsletterChatChannel,
	NewsletterDeliveryDestination,
	NewsletterDetailLevel,
} from "@repo/database";
import {
	cadenceDefaultLookbackDays,
	coerceDeliveryDestination,
	coerceDetailLevel,
	isNewsletterDue,
	isScheduledNewsletterActorValid,
	listEnabledNewsletterSettings,
	resolveWindow,
	scheduledDedupeKey,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";

export interface DueNewsletterProject {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	triggeredByUserId: string;
	projectName: string;
	timeWindowStart: string; // ISO
	timeWindowEnd: string; // ISO
	dedupeKey: string;
	detailLevel: NewsletterDetailLevel;
	deliveryDestination: NewsletterDeliveryDestination;
	chatChannels: NewsletterChatChannel[];
	requireApproval: boolean;
}
export interface FindDueNewsletterProjectsOutput {
	due: DueNewsletterProject[];
}

export async function findDueNewsletterProjectsActivity(): Promise<FindDueNewsletterProjectsOutput> {
	heartbeat("findDueNewsletterProjects");
	const now = new Date();
	const all = await listEnabledNewsletterSettings();
	const due: DueNewsletterProject[] = [];

	for (const s of all) {
		if (!isNewsletterDue(s, now)) {
			continue;
		}
		// Refuse to run an org scheduled send under a stale actor. createdByUserId
		// becomes triggeredByUserId, which drives AI model resolution (org context
		// prefers the actor's personal provider) + usage logging — so a removed or
		// deleted admin must not keep powering the org newsletter. Skipping (not
		// disabling) is recoverable: a current admin re-saving settings re-homes
		// createdByUserId (see upsertNewsletterSettings) and the send resumes.
		if (
			!(await isScheduledNewsletterActorValid(
				s.createdByUserId,
				s.organizationId,
				s.userId,
			))
		) {
			logger.warn(
				"[Newsletter] Skipping scheduled send: configuring admin is no longer a valid member of the organization",
				{
					projectId: s.projectId,
					organizationId: s.organizationId,
					createdByUserId: s.createdByUserId,
				},
			);
			continue;
		}
		const window = resolveWindow(
			s,
			now,
			cadenceDefaultLookbackDays(s.cadence),
		);
		due.push({
			projectId: s.projectId,
			organizationId: s.organizationId,
			userId: s.userId,
			triggeredByUserId: s.createdByUserId,
			projectName: s.project?.name ?? "your project",
			timeWindowStart: window.start.toISOString(),
			timeWindowEnd: window.end.toISOString(),
			dedupeKey: scheduledDedupeKey(s.projectId, s.cadence, now),
			detailLevel: coerceDetailLevel(s.detailLevel),
			deliveryDestination: coerceDeliveryDestination(
				s.deliveryDestination,
			),
			chatChannels: (s.chatChannels ?? []) as NewsletterChatChannel[],
			requireApproval: s.requireApproval,
		});
	}
	return { due };
}
