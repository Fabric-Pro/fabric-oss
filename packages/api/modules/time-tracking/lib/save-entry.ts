/**
 * The steps create and update share: resolving the project an entry is saved
 * on, snapshotting its work item, checking warnings, and the wire shape of a
 * saved entry.
 */

import { ORPCError } from "@orpc/server";
import {
	findStoryForTimeEntry,
	listAuthorTimeEntriesOnWorkDate,
	loadTimeTrackingProject,
	type ProjectStatus,
	type TimeEntryRow,
	type TimePolicyRow,
	type TimeTrackingProject as TimeTrackingProjectRow,
} from "@repo/database";
import {
	detectTimeEntryWarnings,
	type EffectiveTimePolicy,
	resolveEffectiveTimePolicy,
	type TimeEntryFacts,
	type TimeEntryWarning,
	type TimeWarningCode,
} from "@repo/utils/time-tracking";
import { PROJECT_NOT_FOUND_MESSAGE } from "../../../orpc/middleware/project-visibility";

interface TimeTrackingProject {
	id: string;
	name: string;
	organizationId: string;
	status: ProjectStatus;
	policy: EffectiveTimePolicy;
}

/** A project row that belongs to an organization and is not soft-deleted. */
export type LiveTimeTrackingProjectRow = TimeTrackingProjectRow & {
	organizationId: string;
	organization: TimePolicyRow;
};

/** The row when it is a live organization project, else null. */
export function liveTimeTrackingProject(
	project: TimeTrackingProjectRow | null,
): LiveTimeTrackingProjectRow | null {
	if (
		!project ||
		project.deletedAt !== null ||
		project.organizationId === null ||
		project.organization === null
	) {
		return null;
	}
	return {
		...project,
		organizationId: project.organizationId,
		organization: project.organization,
	};
}

/**
 * The live organization project row, settings included. A soft-deleted
 * project is refused like a missing one: a soft delete cascades nothing, so
 * its rows would otherwise keep accepting time nobody can see.
 */
export async function requireLiveTimeTrackingProject(
	projectId: string,
): Promise<LiveTimeTrackingProjectRow> {
	const project = liveTimeTrackingProject(
		await loadTimeTrackingProject(projectId),
	);
	if (!project) {
		throw new ORPCError("NOT_FOUND", {
			message: PROJECT_NOT_FOUND_MESSAGE,
		});
	}
	return project;
}

/**
 * The live organization project an entry is on, with its current effective
 * policy (see {@link requireLiveTimeTrackingProject}). Any status is accepted
 * here, so existing entries on an archived or completed project stay readable
 * and editable in place; see {@link assertAcceptsNewTime} for where new time
 * may go.
 */
export async function requireTimeTrackingProject(
	projectId: string,
): Promise<TimeTrackingProject> {
	const project = await requireLiveTimeTrackingProject(projectId);
	return {
		id: project.id,
		name: project.name,
		organizationId: project.organizationId,
		status: project.status,
		policy: resolveEffectiveTimePolicy({
			org: project.organization,
			project,
		}),
	};
}

/**
 * New time, whether a new entry or one moved in, goes only to an ACTIVE
 * project. Any other status is refused in the same words as a missing project,
 * matching what `listLoggableProjects` offers.
 */
export function assertAcceptsNewTime(project: TimeTrackingProject): void {
	if (project.status !== "ACTIVE") {
		throw new ORPCError("NOT_FOUND", {
			message: PROJECT_NOT_FOUND_MESSAGE,
		});
	}
}

interface StorySnapshot {
	storyId: string | null;
	storyIdentifier: string | null;
	storyTitle: string | null;
}

const NO_STORY: StorySnapshot = {
	storyId: null,
	storyIdentifier: null,
	storyTitle: null,
};

/**
 * The work item an entry links to, as it reads now. Refused when it is not a
 * work item of the entry's project.
 */
export async function snapshotStory(params: {
	projectId: string;
	storyId: string | null | undefined;
}): Promise<StorySnapshot> {
	if (!params.storyId) {
		return NO_STORY;
	}
	const story = await findStoryForTimeEntry({
		projectId: params.projectId,
		storyId: params.storyId,
	});
	if (!story) {
		throw new ORPCError("BAD_REQUEST", {
			message: "The work item is not part of this project",
		});
	}
	return {
		storyId: story.id,
		storyIdentifier: story.identifier,
		storyTitle: story.title,
	};
}

/**
 * Every warning the proposed entry raises, and whether any of them has not
 * been acknowledged yet. A save goes ahead only when `blocked` is false.
 */
export async function evaluateEntryWarnings(params: {
	organizationId: string;
	userId: string;
	proposed: TimeEntryFacts;
	acknowledged: readonly TimeWarningCode[];
	editingEntryId?: string;
}): Promise<{ warnings: TimeEntryWarning[]; blocked: boolean }> {
	const { startAt, stopAt } = params.proposed;
	const existingEntries = await listAuthorTimeEntriesOnWorkDate({
		organizationId: params.organizationId,
		userId: params.userId,
		workDate: params.proposed.workDate,
		overlapping: startAt && stopAt ? { startAt, stopAt } : null,
	});
	const warnings = detectTimeEntryWarnings({
		proposed: params.proposed,
		existingEntries,
		editingEntryId: params.editingEntryId,
	});
	return {
		warnings,
		blocked: warnings.some(
			(warning) => !params.acknowledged.includes(warning.code),
		),
	};
}

/** A time entry as every time-tracking procedure returns it. */
export function serializeTimeEntry(entry: TimeEntryRow) {
	return {
		id: entry.id,
		projectId: entry.projectId,
		projectName: entry.projectName,
		workDate: entry.workDate,
		timezone: entry.timezone,
		durationMinutes: entry.durationMinutes,
		startAt: entry.startAt?.toISOString() ?? null,
		stopAt: entry.stopAt?.toISOString() ?? null,
		activity: entry.activity,
		billable: entry.billable,
		description: entry.description,
		storyId: entry.storyId,
		storyIdentifier: entry.storyIdentifier,
		storyTitle: entry.storyTitle,
		startStopRequired: entry.startStopRequired,
		createdAt: entry.createdAt.toISOString(),
		updatedAt: entry.updatedAt.toISOString(),
	};
}

export type SaveTimeEntryResult =
	| { status: "needs_confirmation"; warnings: TimeEntryWarning[] }
	| {
			status: "saved";
			entry: ReturnType<typeof serializeTimeEntry>;
			warnings: TimeEntryWarning[];
	  };
