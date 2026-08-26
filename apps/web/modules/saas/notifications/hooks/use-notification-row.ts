"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { useBasePath } from "@saas/organizations/hooks/use-organization-context";
import type { orpcClient } from "@shared/lib/orpc-client";
import {
	AlertCircleIcon,
	AtSignIcon,
	BellIcon,
	BotIcon,
	CheckCircleIcon,
	CircleAlertIcon,
	CornerDownRightIcon,
	CreditCardIcon,
	FilePenLineIcon,
	FlagIcon,
	Loader2Icon,
	MegaphoneIcon,
	Share2Icon,
	UserPlusIcon,
} from "lucide-react";
import { toast } from "sonner";
import { resolveNotificationLink } from "../lib/resolve-notification-link";

type ListResult = Awaited<ReturnType<typeof orpcClient.notifications.list>>;
export type NotificationView = ListResult["items"][number];

/**
 * Props shared by both notification layouts — the compact row and the stacked
 * card (#2117). `NotificationListItem` switches between them on the user's
 * display preference and forwards this shape unchanged.
 */
export type NotificationRowProps = {
	notification: NotificationView;
	onSelect: (id: string) => void;
	onArchive?: (id: string) => void;
	onRestore?: (id: string) => void;
	mode?: "default" | "archived";
};

const ICON_BY_CATEGORY = {
	MENTION: AtSignIcon,
	REPLY: CornerDownRightIcon,
	ASSIGNMENT: UserPlusIcon,
	// Decision ownership routing (Fizzy #2029): assigned reads like any other
	// assignment; the update variant uses a pen-on-file glyph.
	DECISION_OWNER_ASSIGNED: UserPlusIcon,
	DECISION_OWNER_UPDATED: FilePenLineIcon,
	STATUS: FlagIcon,
	AGENT: BotIcon,
	PROJECT: FlagIcon,
	BILLING: CreditCardIcon,
	SYSTEM: CircleAlertIcon,
	// CONTEXT_INDEXING_STARTED gets a spinner icon (Loader2) to signal "work
	// in flight". The bell renders icons as static glyphs (no spinning
	// animation) per the design system's "motion with purpose" principle —
	// the loader shape alone reads as "in progress" without needing the
	// continuous rotation. Spec §8.1.
	CONTEXT_INDEXING_STARTED: Loader2Icon,
	// CONTEXT_INDEXING_COMPLETED is the default success icon; the failure
	// case (status: "FAILED" in the payload) overrides to AlertCircleIcon
	// inside the component below via `resolveIcon()`. Spec §8.1.
	CONTEXT_INDEXING_COMPLETED: CheckCircleIcon,
	// Subscription (watch document/feature) updates — bell glyph reads as
	// "you're watching this". DOCUMENT_UPDATED / FEATURE_UPDATED both map here
	// via their SUBSCRIPTION category.
	SUBSCRIPTION: BellIcon,
	// Publishing suggestion cycles (Fizzy #1850) — same glyph as the settings
	// toggle for this category, so the bell row and the preference row read as
	// the same feature.
	PUBLISHING: MegaphoneIcon,
} as const;

/**
 * Resolve the right icon for a notification row. Most categories map 1:1 via
 * `ICON_BY_CATEGORY`. `CONTEXT_INDEXING_COMPLETED` is the lone exception —
 * success and failure share the same category, so the icon depends on the
 * payload's `status` field. Per spec §8.1: success → CheckCircleIcon,
 * failure → AlertCircleIcon.
 */
function resolveIcon(notification: {
	type: NotificationView["type"];
	category: NotificationView["category"];
	payload: NotificationView["payload"];
}): typeof CircleAlertIcon {
	// Report run notifications: success and failure are distinct
	// types, so map each 1:1 to the check / alert glyph. Their category is SYSTEM,
	// whose default glyph (CircleAlert) reads as failure for both — hence the
	// per-type override.
	if (notification.type === "REPORT_COMPLETED") {
		return CheckCircleIcon;
	}
	if (notification.type === "REPORT_FAILED") {
		return AlertCircleIcon;
	}
	// STORY_SHARED reuses the MENTION category (so it stays out of the Mentions
	// tab), but a "shared a feature with you" row reads better with a share
	// glyph than the `@` mention glyph — override per-type here.
	if (notification.type === "STORY_SHARED") {
		return Share2Icon;
	}
	if (notification.category === "CONTEXT_INDEXING_COMPLETED") {
		// Defensive: notification.payload is typed Json; in practice it's
		// always an object when our writers populate it, but we narrow before
		// reading `status` to keep the icon-resolution branch type-safe.
		const status =
			notification.payload &&
			typeof notification.payload === "object" &&
			!Array.isArray(notification.payload)
				? (notification.payload as { status?: unknown }).status
				: undefined;
		return status === "FAILED" ? AlertCircleIcon : CheckCircleIcon;
	}
	return ICON_BY_CATEGORY[notification.category] ?? CircleAlertIcon;
}

/**
 * Notification types whose payload links land inside the admin monitoring
 * dashboard. The dashboard page itself enforces an admin gate (see
 * `apps/web/app/(saas)/app/(account)/admin/monitoring/page.tsx`), so following
 * the link as a non-admin redirects to `/app`. That's a poor experience —
 * the row looks actionable but the destination silently disappears.
 *
 * Instead, the row checks the current user's role client-side. Admins get
 * the normal Link navigation. Non-admins get a small toast explaining the
 * page is admin-only and the row is marked-as-read with no navigation
 * (mirroring the "inbox sees, dashboard acts" intent: the org-owner row
 * gives them visibility; only an admin acknowledges from the dashboard).
 */
const ADMIN_ONLY_NOTIFICATION_TYPES = new Set([
	"INTEGRATION_INCIDENT",
	"SYSTEM_INCIDENT",
]);

/**
 * Everything the compact row and the stacked card share: which glyph to draw,
 * where the row points, whether it is unread, and the admin-incident gate.
 * Both layouts call this, so the gate cannot drift between them.
 */
export function useNotificationRow(
	notification: NotificationView,
	onSelect: (id: string) => void,
) {
	const { user } = useSession();
	const Icon = resolveIcon(notification);
	// Resolve the stored link. Context-relative links resolve against the
	// notification's OWN org base (from `organizationSlug`) so the destination is
	// fixed by the notification, not by whichever workspace the user is viewing.
	// Slug-less admin links (e.g. the weekly digest's
	// `/app/admin/monitoring?week=…`) re-base onto the CURRENT workspace so a
	// system admin stays in their org. See `resolveNotificationLink`.
	const currentBasePath = useBasePath();
	// `organizationSlug` is null for personal notifications (and, defensively, if
	// the server could not resolve a row's org slug) → fall back to the personal
	// base `/app`.
	const notificationBasePath = notification.organizationSlug
		? `/app/${notification.organizationSlug}`
		: "/app";
	const targetPath = resolveNotificationLink(notification.link, {
		notificationBasePath,
		currentBasePath,
	});
	const isUnread = notification.readAt === null;
	const created =
		typeof notification.createdAt === "string"
			? new Date(notification.createdAt)
			: notification.createdAt;

	// Admin-only redirect gate: INTEGRATION_INCIDENT / SYSTEM_INCIDENT rows
	// link to `/app/admin/monitoring`, which silently redirects non-admins to
	// `/app`. Detect that case and degrade gracefully — mark as read, surface
	// a "this is admin-only" toast, and skip navigation.
	const isAdminOnlyType = ADMIN_ONLY_NOTIFICATION_TYPES.has(
		notification.type,
	);
	const isAdmin = user?.role === "admin";
	const shouldBlockAdminLink = isAdminOnlyType && !isAdmin;

	const handleClick = () => onSelect(notification.id);

	const handleAdminGatedClick = (e: React.MouseEvent) => {
		// Mark the row read regardless of whether we navigate. The notification
		// has already conveyed its message; keeping it unread just adds noise.
		onSelect(notification.id);
		if (shouldBlockAdminLink) {
			e.preventDefault();
			toast.info(
				"Monitoring dashboard requires admin access. The incident is logged here for visibility only.",
			);
		}
	};

	return {
		Icon,
		targetPath,
		isUnread,
		created,
		isAdminOnlyType,
		shouldBlockAdminLink,
		handleClick,
		handleAdminGatedClick,
	};
}
