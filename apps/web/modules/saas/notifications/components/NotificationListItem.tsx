"use client";

import type { NotificationRowProps } from "../hooks/use-notification-row";
import { NotificationCard } from "./NotificationCard";
import { NotificationRow } from "./NotificationRow";

/**
 * Notification list entry — picks between the compact row and the stacked card
 * (#2117).
 *
 * The display preference arrives as a prop rather than being read from a hook
 * here. Both consumers (the inbox page and the bell popover) already resolve it
 * for their own container spacing, so the container is the natural single
 * source of truth for a list; and keeping this component free of data
 * dependencies means a row still renders with no QueryClient in scope.
 *
 * Defaults to the compact row, matching the opt-in default of the preference
 * itself.
 *
 * Both layouts share `useNotificationRow`, so link resolution, the
 * admin-incident gate and mark-as-read cannot diverge between them.
 */
export function NotificationListItem({
	stacked = false,
	...props
}: NotificationRowProps & { stacked?: boolean }) {
	return stacked ? (
		<NotificationCard {...props} />
	) : (
		<NotificationRow {...props} />
	);
}
