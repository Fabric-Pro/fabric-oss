/**
 * Tells the people who can act on it that background work is waiting for a
 * ChatGPT plan to reset, or stopped because every plan stayed spent (Fizzy
 * #3050). Without these the work waits or fails silently: a bulk run's
 * `PlanPausedNotice` shows only to someone who opens its page.
 *
 * Recipients are the member who started the work, when a person did, plus
 * the organization's owners and admins, de-duplicated. Scheduled and system
 * work has no initiator, so only owners and admins hear about it.
 *
 * Lives in `@repo/database` beside `chatgpt-plan-org-account-notifications.ts`
 * because its callers are Temporal activities, which cannot import the
 * `@repo/api` notification service. Like that writer it is in-app only,
 * category SYSTEM (always on: no preference toggle suppresses it), and never
 * throws. A dedupe key per run and recipient keeps a retried activity from
 * stacking a second unread row.
 */
import { db, NotificationCategory, NotificationType } from "../client";
import type { BulkRunKind } from "./bulk-run-pause";

const NOTIFIABLE_ROLES = ["owner", "admin"] as const;

/** The cap `createNotification` applies to every snippet. */
const SNIPPET_MAX_LENGTH = 280;

const WHAT_TO_DO =
	"Run it again later, or ask an admin to let background work use the organization's AI provider.";

/**
 * Background work that waits in place for a plan reset and fails for good
 * when the plans stay spent (`withChatGptPlanWait`).
 */
export type PlanWaitWorkKind =
	| "DAILY_BRIEF"
	| "PUBLISHING_SUGGESTIONS"
	| "NEWSLETTER"
	| "DOCUMENT_REFRESH"
	| "CONTEXT_SUMMARY"
	| "WORKFLOW_RUN"
	| "SCHEDULED_REPORT"
	| "MEETING_ANALYSIS"
	| "SLACK_BACKFILL";

export type PlanWorkKind = BulkRunKind | PlanWaitWorkKind;

const WORK_LABELS: Record<PlanWorkKind, string> = {
	PROJECT_SCAN: "A security and accessibility scan",
	SCAN_REVIEW: "A review of scan findings",
	SCAN_GROUPING: "Grouping scan findings into tickets",
	DOCUMENT_BATCH: "A batch document generation",
	ATLAS_ANALYSIS: "An Atlas analysis",
	PROJECT_SETUP: "A project setup",
	DAILY_BRIEF: "A daily brief",
	PUBLISHING_SUGGESTIONS: "Publishing suggestions",
	NEWSLETTER: "A scheduled newsletter",
	DOCUMENT_REFRESH: "A document refresh",
	CONTEXT_SUMMARY: "A context summary",
	WORKFLOW_RUN: "A workflow run",
	SCHEDULED_REPORT: "A scheduled report",
	MEETING_ANALYSIS: "A meeting transcript analysis",
	SLACK_BACKFILL: "A Slack channel backfill",
};

/** Where each bulk run shows its paused notice. Context-relative. */
const BULK_RUN_TABS: Partial<Record<BulkRunKind, string>> = {
	PROJECT_SCAN: "security",
	SCAN_REVIEW: "security",
	SCAN_GROUPING: "security",
	DOCUMENT_BATCH: "documents",
	ATLAS_ANALYSIS: "atlas",
};

/**
 * Why the work stopped. `PLAN_SPENT`: the plans stayed spent past the wait
 * (a bulk run's pause cap, or an in-place wait's second refusal).
 * `RESUME_LOST`: a paused run's resume never started.
 */
export type PlanWorkStoppedReason = "PLAN_SPENT" | "RESUME_LOST";

export const PLAN_WORK_PAUSED_TITLE =
	"Background work is waiting for a ChatGPT plan to reset";
export const PLAN_WORK_STOPPED_TITLE =
	"Background work stopped: every ChatGPT plan stayed spent";

export interface PlanWorkPausedPayload {
	work: PlanWorkKind;
	runId: string;
	projectId?: string;
	projectName?: string;
	resumesAt: string;
}

export interface PlanWorkStoppedPayload {
	work: PlanWorkKind;
	runId: string;
	projectId?: string;
	projectName?: string;
	reason: PlanWorkStoppedReason;
}

interface WorkContext {
	organizationId: string | null;
	/** The member who started the work; null for scheduled and system work. */
	initiatorUserId: string | null;
	projectId: string | null;
}

interface PlanWorkNotice {
	type: NotificationType;
	title: string;
	snippet: string;
	link: string | null;
	payload: PlanWorkPausedPayload | PlanWorkStoppedPayload;
	dedupePrefix: string;
}

/**
 * A bulk run paused for the first time. The caller fires this once per run;
 * later pauses of the same run stay quiet.
 */
export async function notifyBulkRunPlanPaused(input: {
	kind: BulkRunKind;
	runId: string;
	resumesAt: Date;
	now?: Date;
}): Promise<void> {
	try {
		const context = await bulkRunContext(input.kind, input.runId);
		if (!context) {
			return;
		}
		const project = await projectOf(context);
		const delay = describeDelay(
			input.resumesAt.getTime() - (input.now ?? new Date()).getTime(),
		);
		await deliver(context, {
			type: NotificationType.CHATGPT_PLAN_WORK_PAUSED,
			title: PLAN_WORK_PAUSED_TITLE,
			snippet: `${workIn(input.kind, project?.name)} is paused until about ${delay} from now, waiting for a ChatGPT plan to reset. It continues automatically.`,
			link: bulkRunLink(input.kind, project?.id),
			payload: {
				work: input.kind,
				runId: input.runId,
				...projectFields(project),
				resumesAt: input.resumesAt.toISOString(),
			},
			dedupePrefix: `chatgptPlanWorkPaused:${input.runId}`,
		});
	} catch (error) {
		console.warn(
			"[ChatGptPlanWorkNotification] paused notice failed",
			{ kind: input.kind, runId: input.runId },
			error,
		);
	}
}

/** A bulk run stopped: its pause cap was reached, or its resume was lost. */
export async function notifyBulkRunPlanStopped(input: {
	kind: BulkRunKind;
	runId: string;
	reason: PlanWorkStoppedReason;
}): Promise<void> {
	try {
		const context = await bulkRunContext(input.kind, input.runId);
		if (!context) {
			return;
		}
		const project = await projectOf(context);
		await deliver(
			context,
			stoppedNotice({
				work: input.kind,
				runId: input.runId,
				reason: input.reason,
				project,
				link: bulkRunLink(input.kind, project?.id),
			}),
		);
	} catch (error) {
		console.warn(
			"[ChatGptPlanWorkNotification] stopped notice failed",
			{ kind: input.kind, runId: input.runId },
			error,
		);
	}
}

/**
 * Work that waited in place for a plan reset was refused again, or the reset
 * was further off than it could wait: it failed for good.
 */
export async function notifyPlanWaitWorkStopped(input: {
	work: PlanWaitWorkKind;
	/** The Temporal run, so a retried activity does not stack a second row. */
	runId: string;
	organizationId: string | null;
	initiatorUserId: string | null;
	projectId?: string | null;
	/** Context-relative; defaults to the project's page. */
	link?: string | null;
}): Promise<void> {
	try {
		const context: WorkContext = {
			organizationId: input.organizationId,
			initiatorUserId: input.initiatorUserId,
			projectId: input.projectId ?? null,
		};
		const project = await projectOf(context);
		await deliver(
			context,
			stoppedNotice({
				work: input.work,
				runId: input.runId,
				reason: "PLAN_SPENT",
				project,
				link: input.link ?? (project ? `projects/${project.id}` : null),
			}),
		);
	} catch (error) {
		console.warn(
			"[ChatGptPlanWorkNotification] stopped notice failed",
			{ work: input.work, runId: input.runId },
			error,
		);
	}
}

function stoppedNotice(args: {
	work: PlanWorkKind;
	runId: string;
	reason: PlanWorkStoppedReason;
	project: { id: string; name: string } | null;
	link: string | null;
}): PlanWorkNotice {
	const what = workIn(args.work, args.project?.name);
	return {
		type: NotificationType.CHATGPT_PLAN_WORK_STOPPED,
		title: PLAN_WORK_STOPPED_TITLE,
		snippet:
			args.reason === "RESUME_LOST"
				? `${what} stopped: it was waiting for a ChatGPT plan to reset, but its resume never started. Run it again.`
				: `${what} stopped because every ChatGPT plan it may use stayed spent. ${WHAT_TO_DO}`,
		link: args.link,
		payload: {
			work: args.work,
			runId: args.runId,
			...projectFields(args.project),
			reason: args.reason,
		},
		dedupePrefix: `chatgptPlanWorkStopped:${args.runId}`,
	};
}

/** Who started a bulk run, in which organization and project. */
async function bulkRunContext(
	kind: BulkRunKind,
	runId: string,
): Promise<WorkContext | null> {
	switch (kind) {
		case "PROJECT_SCAN": {
			const scan = await db.projectScan.findUnique({
				where: { id: runId },
				select: {
					userId: true,
					organizationId: true,
					projectId: true,
					trigger: true,
				},
			});
			// A maturation-gate scan starts itself; its `userId` did not ask.
			return scan
				? {
						organizationId: scan.organizationId,
						initiatorUserId:
							scan.trigger === "MANUAL" ? scan.userId : null,
						projectId: scan.projectId,
					}
				: null;
		}
		case "SCAN_REVIEW":
		case "SCAN_GROUPING": {
			const row = await (kind === "SCAN_REVIEW"
				? db.scanFindingReview.findUnique({
						where: { id: runId },
						select: {
							userId: true,
							organizationId: true,
							projectId: true,
						},
					})
				: db.scanFindingGrouping.findUnique({
						where: { id: runId },
						select: {
							userId: true,
							organizationId: true,
							projectId: true,
						},
					}));
			return row
				? {
						organizationId: row.organizationId,
						initiatorUserId: row.userId,
						projectId: row.projectId,
					}
				: null;
		}
		case "DOCUMENT_BATCH":
		case "PROJECT_SETUP": {
			const task = await db.agentTask.findUnique({
				where: { id: runId },
				select: { userId: true, organizationId: true, input: true },
			});
			if (!task) {
				return null;
			}
			const projectId = (task.input as { projectId?: unknown } | null)
				?.projectId;
			return {
				organizationId: task.organizationId,
				initiatorUserId: task.userId,
				projectId: typeof projectId === "string" ? projectId : null,
			};
		}
		case "ATLAS_ANALYSIS": {
			// `userId` is the analysis owner; `triggeredByUserId` is who asked.
			const run = await db.atlasAnalysisRun.findUnique({
				where: { id: runId },
				select: {
					triggeredByUserId: true,
					organizationId: true,
					projectId: true,
				},
			});
			return run
				? {
						organizationId: run.organizationId,
						initiatorUserId: run.triggeredByUserId,
						projectId: run.projectId,
					}
				: null;
		}
		default: {
			const unreachable: never = kind;
			return unreachable;
		}
	}
}

async function projectOf(
	context: WorkContext,
): Promise<{ id: string; name: string } | null> {
	if (!context.projectId) {
		return null;
	}
	return db.project.findFirst({
		where: {
			id: context.projectId,
			organizationId: context.organizationId,
		},
		select: { id: true, name: true },
	});
}

/**
 * The initiator and the organization's owners and admins, each once. Only
 * current members: someone who left the organization hears nothing. Work
 * with no organization reaches its initiator alone.
 */
export async function resolvePlanWorkRecipients(context: {
	organizationId: string | null;
	initiatorUserId: string | null;
}): Promise<string[]> {
	if (!context.organizationId) {
		return context.initiatorUserId ? [context.initiatorUserId] : [];
	}
	const members = await db.member.findMany({
		where: { organizationId: context.organizationId },
		select: { userId: true, role: true },
	});
	return [
		...new Set(
			members
				.filter(
					(member) =>
						(NOTIFIABLE_ROLES as readonly string[]).includes(
							member.role,
						) || member.userId === context.initiatorUserId,
				)
				.map((member) => member.userId),
		),
	];
}

async function deliver(
	context: WorkContext,
	notice: PlanWorkNotice,
): Promise<void> {
	const recipients = await resolvePlanWorkRecipients(context);
	const projectId = notice.payload.projectId ?? null;
	await Promise.all(
		recipients.map((userId) =>
			writeRow(context, notice, userId, projectId).catch((error) => {
				console.warn(
					"[ChatGptPlanWorkNotification] row write failed",
					{ type: notice.type, userId },
					error,
				);
			}),
		),
	);
}

async function writeRow(
	context: WorkContext,
	notice: PlanWorkNotice,
	userId: string,
	projectId: string | null,
): Promise<void> {
	try {
		await db.notification.create({
			data: {
				userId,
				organizationId: context.organizationId,
				...(projectId && { projectId }),
				type: notice.type,
				category: NotificationCategory.SYSTEM,
				title: notice.title,
				snippet: truncateSnippet(notice.snippet),
				link: notice.link,
				payload: { ...notice.payload },
				dedupeKey: `${notice.dedupePrefix}:${userId}`,
			},
		});
	} catch (error) {
		if ((error as { code?: string } | null)?.code === "P2002") {
			return;
		}
		throw error;
	}
}

function bulkRunLink(
	kind: BulkRunKind,
	projectId: string | undefined,
): string | null {
	if (!projectId) {
		return null;
	}
	const tab = BULK_RUN_TABS[kind];
	return tab ? `projects/${projectId}?tab=${tab}` : `projects/${projectId}`;
}

function workIn(work: PlanWorkKind, projectName: string | undefined): string {
	const label = WORK_LABELS[work];
	return projectName ? `${label} in "${projectName}"` : label;
}

function projectFields(project: { id: string; name: string } | null): {
	projectId?: string;
	projectName?: string;
} {
	return project ? { projectId: project.id, projectName: project.name } : {};
}

/** "45 minutes", "1 hour", "3 hours": the recipient's time zone is unknown. */
export function describeDelay(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) {
		return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	}
	const hours = Math.round(minutes / 60);
	return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function truncateSnippet(snippet: string): string {
	if (snippet.length <= SNIPPET_MAX_LENGTH) {
		return snippet;
	}
	return `${snippet.slice(0, SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}
