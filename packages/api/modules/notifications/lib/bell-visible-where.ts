import type { Prisma } from "@repo/database";
import {
	INCIDENT_NOTIFICATION_TYPES,
	WEEKLY_DIGEST_DEDUPE_PREFIX,
} from "./incident-notification-types";

type BellVisibleWhereArgs = {
	userId: string;
	organizationId: string;
};

/**
 * Rows visible in the notification bell for one resolved organization.
 *
 * Ordinary rows and organization-scoped weekly digests must belong to the
 * resolved organization. The one account-global exception is the weekly
 * incident digest, which is written with `organizationId: null`. Every arm is
 * still pinned by the caller's `userId`, and null-organization per-incident
 * alerts remain excluded because they do not match the digest key prefix.
 */
export function bellVisibleWhere({
	userId,
	organizationId,
}: BellVisibleWhereArgs): Prisma.NotificationWhereInput {
	return {
		userId,
		OR: [
			{
				organizationId,
				type: { notIn: INCIDENT_NOTIFICATION_TYPES },
			},
			{
				organizationId,
				dedupeKey: { startsWith: WEEKLY_DIGEST_DEDUPE_PREFIX },
			},
			{
				organizationId: null,
				dedupeKey: { startsWith: WEEKLY_DIGEST_DEDUPE_PREFIX },
			},
		],
	};
}
