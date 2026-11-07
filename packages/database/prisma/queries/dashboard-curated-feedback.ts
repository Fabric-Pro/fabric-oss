import { db } from "../client";

export const DASHBOARD_CURATED_FEEDBACK_ACTIONS = [
	"click",
	"pin",
	"unpin",
	"dismiss",
	"restore",
] as const;

export type DashboardCuratedFeedbackAction =
	(typeof DASHBOARD_CURATED_FEEDBACK_ACTIONS)[number];

interface CuratedFeedbackActor {
	userId: string;
	organizationId: string;
}

const CURATED_PREFERENCE_SELECT = {
	cardKey: true,
	pinnedAt: true,
	dismissedAt: true,
	clickCount: true,
	lastClickedAt: true,
	updatedAt: true,
} as const;

export async function listDashboardCuratedFeedback({
	userId,
	organizationId,
}: CuratedFeedbackActor) {
	return db.dashboardCuratedPreference.findMany({
		where: { userId, organizationId },
		select: CURATED_PREFERENCE_SELECT,
		orderBy: { updatedAt: "desc" },
	});
}

export async function recordDashboardCuratedFeedback({
	userId,
	organizationId,
	cardKey,
	action,
	now = new Date(),
}: CuratedFeedbackActor & {
	cardKey: string;
	action: DashboardCuratedFeedbackAction;
	now?: Date;
}) {
	const state = {
		...(action === "pin" ? { pinnedAt: now, dismissedAt: null } : {}),
		...(action === "unpin" ? { pinnedAt: null } : {}),
		...(action === "dismiss" ? { pinnedAt: null, dismissedAt: now } : {}),
		...(action === "restore" ? { dismissedAt: null } : {}),
	};

	return db.dashboardCuratedPreference.upsert({
		where: {
			organizationId_userId_cardKey: {
				organizationId,
				userId,
				cardKey,
			},
		},
		create: {
			userId,
			organizationId,
			cardKey,
			...state,
			clickCount: action === "click" ? 1 : 0,
			lastClickedAt: action === "click" ? now : null,
		},
		update:
			action === "click"
				? {
						clickCount: { increment: 1 },
						lastClickedAt: now,
						dismissedAt: null,
					}
				: state,
		select: CURATED_PREFERENCE_SELECT,
	});
}
