import type { MyWorkItem, MyWorkResult } from "@repo/database";
import { resolveNotificationLink } from "@saas/notifications/lib/resolve-notification-link";

export interface HomeNotification {
	id: string;
	type: string;
	title: string;
	snippet: string | null;
	link: string | null;
	readAt: string | Date | null;
	createdAt: string | Date;
	projectId: string | null;
	projectName: string | null;
	organizationSlug: string | null;
}

export interface HomeTodo {
	id: string;
	title: string;
	projectId: string | null;
	projectName: string | null;
	canOpenProject: boolean;
	meetingTitle: string | null;
	sourceDate: string;
	isCompleted: boolean;
}

export interface HomeProjectShortcut {
	id: string;
	name: string;
	organizationSlug: string | null;
	lastVisitedAt: string | Date | null;
	isFavorite?: boolean;
}

export interface HomeProjectVisit {
	projectId: string;
	lastVisitedAt: string | Date | null;
}

export interface HomeActionItem {
	id: string;
	title: string;
	reason: string;
	projectName: string | null;
	projectId?: string | null;
	href: string;
	actionLabel: "Answer" | "Review" | "Open";
	updatedAt: Date;
	priority: number;
	blocked: boolean;
}

export interface ProjectActivitySummary {
	projectId: string;
	projectName: string;
	href: string;
	summary: string;
	latestAt: Date;
}

const HEALTH_TYPES = new Set([
	"PM_SYNC_CONFLICT",
	"AI_USAGE_LIMIT_WARNING",
	"AI_USAGE_LIMIT_REACHED",
	"INTEGRATION_INCIDENT",
	"SYSTEM_INCIDENT",
	"REPO_INTEGRATION_TOKEN_EXPIRED",
	"PM_ATTACHMENT_SYNC_FAILED",
	"CHATGPT_PLAN_ACCOUNT_NEEDS_RECONNECT",
]);

const ACTIONABLE_TYPES = new Set([
	"STORY_MENTION",
	"STORY_COMMENT_REPLY",
	"STORY_ASSIGNED",
	"TASK_MENTION",
	"TASK_COMMENT_REPLY",
	"COMMENT_MENTION",
	"DOCUMENT_MENTION",
	"AGENT_REPLY_READY",
	"PM_SYNC_CONFLICT",
	"REPO_INTEGRATION_TOKEN_EXPIRED",
	"REPORT_FAILED",
	"NEWSLETTER_APPROVAL_PENDING",
	"PROMPT_NOMINATION_PENDING",
	"PM_ATTACHMENT_SYNC_FAILED",
	"DECISION_OWNER_ASSIGNED",
	"DECISION_OWNER_UPDATED",
	"QUESTION_ASSIGNED",
	"QUESTION_MENTIONED",
	"PUBLISHING_TOPIC_ASSIGNED",
	"PUBLISHING_QUESTION_ASSIGNED",
	"DOCUMENT_GENERATION_FAILED",
	"CLI_CONNECTION_REQUESTED",
	"TODO_ASSIGNED",
	"TODO_MEETING_ITEMS_ASSIGNED",
	"WORKFLOW_RUN_FAILED",
	"CHATGPT_PLAN_ACCOUNT_NEEDS_RECONNECT",
	"CHATGPT_PLAN_WORK_STOPPED",
]);

const ANSWER_TYPES = new Set([
	"DECISION_OWNER_ASSIGNED",
	"DECISION_OWNER_UPDATED",
	"QUESTION_ASSIGNED",
	"QUESTION_MENTIONED",
	"PUBLISHING_QUESTION_ASSIGNED",
]);

const REVIEW_TYPES = new Set([
	"NEWSLETTER_APPROVAL_PENDING",
	"PROMPT_NOMINATION_PENDING",
	"AGENT_REPLY_READY",
]);

function asDate(value: string | Date): Date {
	return value instanceof Date ? value : new Date(value);
}

function notificationHref(
	notification: HomeNotification,
	currentBasePath: string,
): string {
	return resolveNotificationLink(notification.link, {
		notificationBasePath: notification.organizationSlug
			? `/app/${notification.organizationSlug}`
			: "/app",
		currentBasePath,
	});
}

function workItem(item: MyWorkItem, blocked: boolean): HomeActionItem {
	return {
		id: `${blocked ? "blocked" : "review"}-${item.kind}-${item.id}`,
		title: item.title,
		reason: item.subtitle ?? item.status ?? (blocked ? "Failed" : "Review"),
		projectName: item.projectName ?? null,
		projectId: item.projectId,
		href: item.href,
		actionLabel: blocked ? "Open" : "Review",
		updatedAt: asDate(item.updatedAt),
		priority: blocked ? 0 : 2,
		blocked,
	};
}

function notificationItem(
	notification: HomeNotification,
	currentBasePath: string,
): HomeActionItem | null {
	if (
		notification.readAt !== null ||
		!ACTIONABLE_TYPES.has(notification.type) ||
		HEALTH_TYPES.has(notification.type) ||
		!notification.link
	) {
		return null;
	}
	return {
		id: `notification-${notification.id}`,
		title: notification.title,
		reason: notification.snippet ?? "Assigned to you",
		projectName: notification.projectName,
		projectId: notification.projectId,
		href: notificationHref(notification, currentBasePath),
		actionLabel: ANSWER_TYPES.has(notification.type)
			? "Answer"
			: REVIEW_TYPES.has(notification.type)
				? "Review"
				: "Open",
		updatedAt: asDate(notification.createdAt),
		priority: ANSWER_TYPES.has(notification.type) ? 1 : 3,
		blocked:
			notification.type.includes("FAILED") ||
			notification.type === "CHATGPT_PLAN_WORK_STOPPED",
	};
}

function todoItem(todo: HomeTodo, basePath: string): HomeActionItem {
	return {
		id: `todo-${todo.id}`,
		title: todo.title,
		reason: todo.meetingTitle ? `To-do · ${todo.meetingTitle}` : "To-do",
		projectName: todo.projectName,
		projectId: todo.projectId,
		href:
			todo.canOpenProject && todo.projectId
				? `${basePath}/projects/${todo.projectId}`
				: `${basePath}/todos`,
		actionLabel: "Open",
		updatedAt: asDate(todo.sourceDate),
		priority: 4,
		blocked: false,
	};
}

export function buildNeedsYou({
	work,
	notifications,
	todos,
	basePath,
	includeTodos,
}: {
	work?: MyWorkResult;
	notifications: HomeNotification[];
	todos: HomeTodo[];
	basePath: string;
	includeTodos: boolean;
}): { items: HomeActionItem[]; total: number; hasMore: boolean } {
	const workItems = [
		...(work?.blocked.items ?? []).map((item) => workItem(item, true)),
		...(work?.needsReview.items ?? []).map((item) => workItem(item, false)),
	];
	const workItemKeys = new Set(
		workItems.map((item) => `${item.href}:${item.title.toLowerCase()}`),
	);
	const notificationItems = notifications
		.filter(
			(notification) =>
				!includeTodos ||
				(notification.type !== "TODO_ASSIGNED" &&
					notification.type !== "TODO_MEETING_ITEMS_ASSIGNED"),
		)
		.map((notification) => notificationItem(notification, basePath))
		.filter(
			(item): item is HomeActionItem =>
				item !== null &&
				!workItemKeys.has(`${item.href}:${item.title.toLowerCase()}`),
		);
	const todoItems = includeTodos
		? todos
				.filter((todo) => !todo.isCompleted)
				.map((todo) => todoItem(todo, basePath))
		: [];
	const items = [...workItems, ...notificationItems, ...todoItems];
	items.sort(
		(a, b) =>
			a.priority - b.priority ||
			b.updatedAt.getTime() - a.updatedAt.getTime(),
	);
	return {
		items: items.slice(0, 7),
		total: items.length,
		hasMore: items.length > 7,
	};
}

export function healthNotifications(
	notifications: HomeNotification[],
	isSystemAdmin: boolean,
): HomeNotification[] {
	return notifications.filter(
		(notification) =>
			notification.readAt === null &&
			HEALTH_TYPES.has(notification.type) &&
			(isSystemAdmin ||
				(notification.type !== "INTEGRATION_INCIDENT" &&
					notification.type !== "SYSTEM_INCIDENT")),
	);
}

const ACTIVITY_LABELS: Record<string, string> = {
	DOCUMENT_GENERATION_COMPLETED: "document generated",
	DOCUMENT_GENERATION_FAILED: "document generation failed",
	STORY_STATUS_CHANGED: "feature updated",
	STORY_ASSIGNED: "feature assigned",
	DECISION_OWNER_ASSIGNED: "decision recorded",
	DECISION_OWNER_UPDATED: "decision updated",
	QUESTION_ANSWERED: "question answered",
	REPORT_COMPLETED: "report completed",
	REPORT_FAILED: "report failed",
	WORKFLOW_RUN_COMPLETED: "workflow completed",
	WORKFLOW_RUN_FAILED: "workflow failed",
	AGENT_REPLY_READY: "agent reply ready",
};

export function buildProjectActivity({
	notifications,
	visits,
	basePath,
}: {
	notifications: HomeNotification[];
	visits: HomeProjectVisit[];
	basePath: string;
}): ProjectActivitySummary[] {
	const lastVisits = new Map(
		visits.map((visit) => [
			visit.projectId,
			visit.lastVisitedAt ? asDate(visit.lastVisitedAt).getTime() : null,
		]),
	);
	const groups = new Map<
		string,
		{
			projectId: string;
			projectName: string;
			organizationSlug: string | null;
			latestAt: Date;
			labels: Map<string, number>;
		}
	>();
	for (const notification of notifications) {
		if (!notification.projectId || !notification.projectName) {
			continue;
		}
		const createdAt = asDate(notification.createdAt);
		const lastVisit = lastVisits.get(notification.projectId);
		if (lastVisit && createdAt.getTime() <= lastVisit) {
			continue;
		}
		const group = groups.get(notification.projectId) ?? {
			projectId: notification.projectId,
			projectName: notification.projectName,
			organizationSlug: notification.organizationSlug,
			latestAt: createdAt,
			labels: new Map<string, number>(),
		};
		if (createdAt > group.latestAt) {
			group.latestAt = createdAt;
		}
		const label = ACTIVITY_LABELS[notification.type] ?? "new activity";
		group.labels.set(label, (group.labels.get(label) ?? 0) + 1);
		groups.set(notification.projectId, group);
	}
	return [...groups.values()]
		.sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime())
		.slice(0, 5)
		.map((group) => ({
			projectId: group.projectId,
			projectName: group.projectName,
			href: `${group.organizationSlug ? `/app/${group.organizationSlug}` : basePath}/projects/${group.projectId}`,
			summary: [...group.labels]
				.slice(0, 3)
				.map(([label, count]) => `${count} ${label}`)
				.join(" · "),
			latestAt: group.latestAt,
		}));
}
