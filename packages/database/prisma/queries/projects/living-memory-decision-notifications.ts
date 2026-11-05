/**
 * "Decision candidates are ready" notifications: an AI found decisions in a
 * new version of a synced Living Memory file, and they wait in the project's
 * Decisions tab for review.
 *
 * Lives in `@repo/database` because the writer is the Temporal extraction
 * activity, which cannot import `@repo/api`. In-app only.
 *
 * One row per person per project, however many files a sync or a push changed.
 * Extractions run per file and finish minutes apart, and no sync id reaches
 * them, so the row is what groups them: its dedupe key names the project, and
 * the partial unique index on unread rows (`Notification.dedupeKey`) keeps one
 * live row per key. Each later extraction refreshes that row instead of adding
 * one, and moves it back to the top of the list. A person who has read the row
 * gets a new one for what arrives next.
 *
 * The row states the project's total: the candidates the Decisions tab offers
 * right now (`summarizeOpenLivingMemoryDecisions`). It is recomputed on every
 * write, so it stays true when a file is edited twice or a reviewer works
 * through the tab while the row is unread, which a running sum would not.
 *
 * Each extraction still announces at most once: the fan-out claims
 * `ProjectContextDecisionExtraction.notifiedAt` with
 * `UPDATE ... WHERE "notifiedAt" IS NULL`. An extraction with nothing OPEN
 * (`openLivingMemoryDecisions`) announces nothing, so an edit that leaves only
 * already converted or dismissed decisions in the file stays quiet.
 *
 * Recipients are the project's people who can create decisions on it (the
 * permission the candidate create flow requires): the owner and the project's
 * accepted, unexpired members, each checked with
 * `canCreateArchitectureDecisions`, minus whoever last wrote the file, then
 * narrowed by the `syncProject` preference toggle (category PROJECT). Never
 * the organization at large: an organization role can grant the permission to
 * someone who cannot see the project.
 *
 * Never throws: a notification failure must not fail or retry an extraction
 * that was already recorded.
 */
import { db, NotificationCategory, NotificationType } from "../../client";
import { getEnabledRecipientsForCategory } from "../notification-preferences";
import {
	openLivingMemoryDecisions,
	summarizeOpenLivingMemoryDecisions,
} from "./living-memory-decisions";
import { canCreateArchitectureDecisions } from "./projects";

/**
 * The stored payload. Registered as `decisionCandidatesReadyPayload` in
 * `@repo/api` `modules/notifications/lib/payloads.ts`; keep the two in step.
 */
export type DecisionCandidatesReadyPayload = {
	projectId: string;
	candidateCount: number;
	fileCount: number;
};

/** How many permission checks run at once while resolving recipients. */
const PERMISSION_CHECK_BATCH = 20;
const SNIPPET_MAX_LENGTH = 280;

/**
 * Claims the extraction's announcement and writes or refreshes each
 * recipient's in-app notification for the project. Returns how many rows were
 * written or refreshed; zero when the extraction found nothing, the claim was
 * already taken, nobody is left to tell, or anything failed.
 */
export async function createDecisionCandidatesReadyNotifications(args: {
	extractionId: string;
}): Promise<number> {
	try {
		const extraction = await db.projectContextDecisionExtraction.findUnique(
			{
				where: { id: args.extractionId },
				select: {
					id: true,
					projectId: true,
					contextId: true,
					contentHash: true,
					decisions: true,
					dismissedIndexes: true,
					organizationId: true,
					context: { select: { contentUpdatedByUserId: true } },
				},
			},
		);
		if (!extraction) {
			return 0;
		}
		if ((await openLivingMemoryDecisions(extraction)).length === 0) {
			return 0;
		}
		const { count } = await db.projectContextDecisionExtraction.updateMany({
			where: { id: extraction.id, notifiedAt: null },
			data: { notifiedAt: new Date() },
		});
		if (count !== 1) {
			return 0;
		}
		const project = await db.project.findUnique({
			where: { id: extraction.projectId },
			select: { name: true, userId: true },
		});
		if (!project) {
			return 0;
		}
		const recipients = await resolveDecisionCandidateRecipients({
			projectId: extraction.projectId,
			ownerUserId: project.userId,
			writerUserId: extraction.context.contentUpdatedByUserId,
		});
		if (recipients.length === 0) {
			return 0;
		}
		const { candidateCount, fileCount } =
			await summarizeOpenLivingMemoryDecisions({
				projectId: extraction.projectId,
				organizationId: extraction.organizationId,
			});
		// The file moved on since this extraction: the newer version's
		// extraction announces what it finds.
		if (candidateCount === 0) {
			return 0;
		}
		const payload: DecisionCandidatesReadyPayload = {
			projectId: extraction.projectId,
			candidateCount,
			fileCount,
		};
		const title =
			candidateCount === 1
				? "1 decision candidate to review"
				: `${candidateCount} decision candidates to review`;
		const snippet = truncate(
			`${project.name}: found in ${fileCount === 1 ? "1 file" : `${fileCount} files`}. Review them in the Decisions tab.`,
		);
		const written = await Promise.all(
			recipients.map((userId) =>
				writeRow({
					userId,
					organizationId: extraction.organizationId,
					title,
					snippet,
					payload,
				}),
			),
		);
		return written.filter(Boolean).length;
	} catch (error) {
		console.warn(
			"[DecisionCandidatesReadyNotification] fan-out failed",
			{ extractionId: args.extractionId },
			error,
		);
		return 0;
	}
}

/**
 * Everyone on the project who may create decisions on it, minus the file's
 * last writer, minus anyone who switched project notifications off.
 * Candidates are the owner and the project's accepted, unexpired members: the
 * people who can see the project at all. An organization member who was never
 * added to the project can hold the permission through an organization role
 * without being able to see the project, so the organization roster is never
 * a candidate source.
 */
export async function resolveDecisionCandidateRecipients(input: {
	projectId: string;
	ownerUserId: string;
	writerUserId: string | null;
}): Promise<string[]> {
	const now = new Date();
	const members = await db.projectMember.findMany({
		where: {
			projectId: input.projectId,
			acceptedAt: { not: null },
			OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
		},
		select: { userId: true },
	});
	const candidates = [
		...new Set([
			input.ownerUserId,
			...members.map((member) => member.userId),
		]),
	].filter((userId) => userId !== input.writerUserId);
	const permitted: string[] = [];
	for (let i = 0; i < candidates.length; i += PERMISSION_CHECK_BATCH) {
		const batch = candidates.slice(i, i + PERMISSION_CHECK_BATCH);
		const allowed = await Promise.all(
			batch.map((userId) =>
				canCreateArchitectureDecisions(input.projectId, userId),
			),
		);
		permitted.push(...batch.filter((_, index) => allowed[index]));
	}
	if (permitted.length === 0) {
		return [];
	}
	const enabled = await getEnabledRecipientsForCategory(
		permitted,
		NotificationCategory.PROJECT,
	);
	return permitted.filter((userId) => enabled.has(userId));
}

function truncate(snippet: string): string {
	return snippet.length <= SNIPPET_MAX_LENGTH
		? snippet
		: `${snippet.slice(0, SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}

type RowInput = {
	userId: string;
	organizationId: string | null;
	title: string;
	snippet: string;
	payload: DecisionCandidatesReadyPayload;
};

function rowDedupeKey(input: RowInput): string {
	return `decisionCandidates:${input.payload.projectId}:${input.userId}`;
}

async function writeRow(input: RowInput): Promise<boolean> {
	try {
		return (await refreshLiveRow(input)) || (await insertRow(input));
	} catch (error) {
		console.warn(
			"[DecisionCandidatesReadyNotification] notification write failed",
			{ projectId: input.payload.projectId, userId: input.userId },
			error,
		);
		return false;
	}
}

/** Update the recipient's unread row, if there is one, and resurface it. */
async function refreshLiveRow(input: RowInput): Promise<boolean> {
	const { count } = await db.notification.updateMany({
		where: {
			userId: input.userId,
			dedupeKey: rowDedupeKey(input),
			readAt: null,
			archivedAt: null,
		},
		data: {
			title: input.title,
			snippet: input.snippet,
			payload: input.payload,
			createdAt: new Date(),
		},
	});
	return count > 0;
}

async function insertRow(input: RowInput): Promise<boolean> {
	try {
		await db.notification.create({
			data: {
				userId: input.userId,
				organizationId: input.organizationId,
				type: NotificationType.DECISION_CANDIDATES_READY,
				category: NotificationCategory.PROJECT,
				title: input.title,
				snippet: input.snippet,
				link: `projects/${input.payload.projectId}?tab=decisions`,
				projectId: input.payload.projectId,
				payload: input.payload,
				dedupeKey: rowDedupeKey(input),
			},
			select: { id: true },
		});
		return true;
	} catch (error) {
		// Another file's extraction created the row first.
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "P2002"
		) {
			return refreshLiveRow(input);
		}
		throw error;
	}
}
