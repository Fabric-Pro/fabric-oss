/**
 * Read-modify-write access to `Workflow.settings`, the free-form JSON column
 * that carries state a run leaves behind for the next one: the frame each
 * Publish Frame node keeps versioning, and the failure counter of an
 * unattended schedule.
 *
 * A scheduled run, a manual run and an auto-pause can all write it, so every
 * write takes the workflow's row lock first and re-reads inside it.
 */

import { db, type Prisma } from "@repo/database";

export type WorkflowSettings = Record<string, unknown>;

/** Node id -> id of the frame its Publish Frame step keeps versioning. */
export const PUBLISH_FRAME_IDS_KEY = "publishFrameIds";

export function parseWorkflowSettings(raw: unknown): WorkflowSettings {
	return raw && typeof raw === "object" && !Array.isArray(raw)
		? { ...(raw as WorkflowSettings) }
		: {};
}

export function readPublishFrameIds(
	settings: WorkflowSettings,
): Record<string, string> {
	const raw = settings[PUBLISH_FRAME_IDS_KEY];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(raw).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

/**
 * What a schedule leaves in `Workflow.settings` for the next fire: how many
 * runs failed in a row, which run was counted last, and, once the workflow
 * paused itself, when and why. Every reader and writer goes through
 * {@link readScheduledRunState} and {@link writeScheduledRunState}, so the keys
 * exist in one place.
 */
export interface ScheduledRunState {
	/** Failed scheduled runs in a row since the last success or resume. */
	consecutiveFailures: number;
	/** The last scheduled execution whose outcome was counted. */
	lastOutcomeExecutionId?: string;
	/** When the owner was first told a scheduled run had finished. */
	firstSuccessNotifiedAt?: string;
	/** Set when the workflow paused itself; stale once someone resumes it. */
	pausedAt?: string;
	pausedReason?: string;
}

const SCHEDULED_RUN_STATE_KEYS = [
	"consecutiveFailures",
	"lastOutcomeExecutionId",
	"firstSuccessNotifiedAt",
	"pausedAt",
	"pausedReason",
] as const satisfies ReadonlyArray<keyof ScheduledRunState>;

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readScheduledRunState(
	settings: WorkflowSettings,
): ScheduledRunState {
	const failures = settings.consecutiveFailures;
	return {
		consecutiveFailures:
			typeof failures === "number" &&
			Number.isFinite(failures) &&
			failures > 0
				? Math.floor(failures)
				: 0,
		lastOutcomeExecutionId: nonEmptyString(settings.lastOutcomeExecutionId),
		firstSuccessNotifiedAt: nonEmptyString(settings.firstSuccessNotifiedAt),
		pausedAt: nonEmptyString(settings.pausedAt),
		pausedReason: nonEmptyString(settings.pausedReason),
	};
}

/** `settings` with its scheduled-run keys replaced by `state`; the rest is kept. */
export function writeScheduledRunState(
	settings: WorkflowSettings,
	state: ScheduledRunState,
): WorkflowSettings {
	const written: WorkflowSettings = { ...settings };
	for (const key of SCHEDULED_RUN_STATE_KEYS) {
		delete written[key];
	}
	for (const key of SCHEDULED_RUN_STATE_KEYS) {
		if (state[key] !== undefined) {
			written[key] = state[key];
		}
	}
	return written;
}

/** Holds the row until the surrounding transaction ends. */
export async function lockWorkflowRow(
	tx: Prisma.TransactionClient,
	workflowId: string,
): Promise<void> {
	await tx.$queryRaw`SELECT id FROM workflow WHERE id = ${workflowId} FOR UPDATE`;
}

/**
 * Apply `change` to the workflow's settings under its row lock. Scoped to the
 * organization so a run can never write another tenant's workflow. Returns
 * false when no such workflow exists in that organization.
 */
export async function updateWorkflowSettings(
	input: { workflowId: string; organizationId: string },
	change: (current: WorkflowSettings) => WorkflowSettings,
): Promise<boolean> {
	return db.$transaction(async (tx) => {
		await lockWorkflowRow(tx, input.workflowId);
		const workflow = await tx.workflow.findFirst({
			where: {
				id: input.workflowId,
				organizationId: input.organizationId,
			},
			select: { settings: true },
		});
		if (!workflow) {
			return false;
		}
		await tx.workflow.update({
			where: { id: input.workflowId },
			data: {
				settings: change(
					parseWorkflowSettings(workflow.settings),
				) as Prisma.InputJsonValue,
			},
		});
		return true;
	});
}
