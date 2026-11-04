/**
 * "A new Coding Instructions version was published" notifications.
 *
 * Lives in `@repo/database` because every path that moves the published
 * pointer must emit it and one of them is the Temporal publish activity,
 * which cannot import `@repo/api`. The oRPC paths (manual publish, proposal
 * approval) call the same writer and then start external delivery
 * (email/webhook) for the rows it returns; the Temporal path is in-app only.
 *
 * At most once per snapshot: the fan-out first claims
 * `ProjectInstructionSnapshot.publishNotifiedAt` with
 * `UPDATE ... WHERE "publishNotifiedAt" IS NULL`. `publishedAt` cannot be the
 * claim, because a rollback to an earlier version overwrites it; a rollback
 * to a version that was already announced therefore announces nothing.
 *
 * Recipients are the project's people, never the organization at large:
 * accepted, unexpired `ProjectMember` rows plus the project's owner, narrowed
 * to those who can read the instructions now (`canReadProjectInstructions`),
 * minus whoever published, then by the `syncProject` preference toggle
 * (category PROJECT).
 *
 * Called after the publish commits. Never throws: a notification failure
 * must not fail or retry a publication that already happened.
 */
import { db, NotificationCategory, NotificationType } from "../client";
import { getEnabledRecipientsForCategory } from "./notification-preferences";
import { canReadProjectInstructions } from "./projects/projects";

/** How the version became the published one. */
export type InstructionPublishedVia =
	| "manual"
	| "proposal_review"
	| "automatic";

/** What a member runs to bring their local copy up to date. */
export type InstructionUpdateHint =
	| { kind: "cli_sync"; command: string }
	| { kind: "git_pull"; ref: string | null };

/**
 * The stored payload. Registered as `codingInstructionsPublishedPayload` in
 * `@repo/api` `modules/notifications/lib/payloads.ts`; keep the two in step.
 */
export type InstructionPublishedPayload = {
	projectId: string;
	snapshotId: string;
	version: number;
	source: "UPLOAD" | "REPOSITORY";
	sourceRef: string | null;
	shortCommitSha: string | null;
	via: InstructionPublishedVia;
	publishedByUserId: string | null;
	publishedByName: string | null;
	update: InstructionUpdateHint;
};

export type CreateInstructionPublishedNotificationsArgs = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	/** The member who published, or whom the automatic run acted as. */
	actorUserId: string | null;
	via: InstructionPublishedVia;
};

const SHORT_SHA_LENGTH = 7;
const SNIPPET_MAX_LENGTH = 280;

/** The CLI command that refreshes an upload-mode project's local copy. */
export function instructionSyncCommand(projectId: string): string {
	return `fabric instructions sync --project ${projectId}`;
}

/**
 * Claims the snapshot's announcement and writes one in-app notification per
 * recipient. Returns the rows written, so an oRPC caller can start external
 * delivery for them; empty when the claim was already taken, nobody is left
 * to tell, or anything failed.
 */
export async function createInstructionPublishedNotifications(
	args: CreateInstructionPublishedNotificationsArgs,
): Promise<Array<{ id: string; userId: string }>> {
	try {
		const { count } = await db.projectInstructionSnapshot.updateMany({
			where: {
				id: args.snapshotId,
				projectId: args.projectId,
				organizationId: args.organizationId,
				publishNotifiedAt: null,
			},
			data: { publishNotifiedAt: new Date() },
		});
		if (count !== 1) {
			return [];
		}
		const snapshot = await db.projectInstructionSnapshot.findFirst({
			where: {
				id: args.snapshotId,
				projectId: args.projectId,
				organizationId: args.organizationId,
			},
			select: {
				version: true,
				source: true,
				sourceRef: true,
				sourceCommitSha: true,
				project: { select: { name: true, userId: true } },
			},
		});
		if (!snapshot) {
			return [];
		}
		const recipients = await resolveInstructionPublishRecipients({
			projectId: args.projectId,
			organizationId: args.organizationId,
			ownerUserId: snapshot.project.userId,
			actorUserId: args.actorUserId,
		});
		if (recipients.length === 0) {
			return [];
		}
		const actor = args.actorUserId
			? await db.user.findUnique({
					where: { id: args.actorUserId },
					select: { name: true },
				})
			: null;
		const repository = snapshot.source === "REPOSITORY";
		const payload: InstructionPublishedPayload = {
			projectId: args.projectId,
			snapshotId: args.snapshotId,
			version: snapshot.version,
			source: repository ? "REPOSITORY" : "UPLOAD",
			sourceRef: snapshot.sourceRef,
			shortCommitSha: snapshot.sourceCommitSha
				? snapshot.sourceCommitSha.slice(0, SHORT_SHA_LENGTH)
				: null,
			via: args.via,
			publishedByUserId: args.actorUserId,
			publishedByName: actor?.name ?? null,
			update: repository
				? { kind: "git_pull", ref: snapshot.sourceRef }
				: {
						kind: "cli_sync",
						command: instructionSyncCommand(args.projectId),
					},
		};
		const title = `Coding instructions v${snapshot.version} published`;
		const snippet = publishedSnippet(snapshot.project.name, payload);
		const written = await Promise.all(
			recipients.map((userId) =>
				writeRow({
					userId,
					organizationId: args.organizationId,
					projectId: args.projectId,
					actorUserId: args.actorUserId,
					title,
					snippet,
					payload,
				}),
			),
		);
		return written.filter(
			(row): row is { id: string; userId: string } => row !== null,
		);
	} catch (error) {
		console.warn(
			"[InstructionPublishedNotification] fan-out failed",
			{ snapshotId: args.snapshotId, projectId: args.projectId },
			error,
		);
		return [];
	}
}

/** How many read-permission checks run at once while resolving recipients. */
const READ_CHECK_BATCH = 20;

/**
 * Everyone who may read the project's instructions, minus the actor, minus
 * anyone who switched project notifications off. Candidates are the owner,
 * the project's members and the organization's members: in an organization a
 * project is often read by people who were never added to it, and each
 * candidate still has to pass the instructions read check.
 */
export async function resolveInstructionPublishRecipients(input: {
	projectId: string;
	organizationId: string;
	ownerUserId: string;
	actorUserId: string | null;
}): Promise<string[]> {
	const now = new Date();
	const [members, orgMembers] = await Promise.all([
		db.projectMember.findMany({
			where: {
				projectId: input.projectId,
				acceptedAt: { not: null },
				OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
			},
			select: { userId: true },
		}),
		db.member.findMany({
			where: { organizationId: input.organizationId },
			select: { userId: true },
		}),
	]);
	const candidates = [
		...new Set([
			input.ownerUserId,
			...members.map((member) => member.userId),
			...orgMembers.map((member) => member.userId),
		]),
	].filter((userId) => userId !== input.actorUserId);
	const readable: string[] = [];
	for (let i = 0; i < candidates.length; i += READ_CHECK_BATCH) {
		const batch = candidates.slice(i, i + READ_CHECK_BATCH);
		const allowed = await Promise.all(
			batch.map((userId) =>
				canReadProjectInstructions(input.projectId, userId),
			),
		);
		readable.push(...batch.filter((_, index) => allowed[index]));
	}
	if (readable.length === 0) {
		return [];
	}
	const enabled = await getEnabledRecipientsForCategory(
		readable,
		NotificationCategory.PROJECT,
	);
	return readable.filter((userId) => enabled.has(userId));
}

function publishedSnippet(
	projectName: string,
	payload: InstructionPublishedPayload,
): string {
	const by =
		payload.via === "automatic" && payload.source === "REPOSITORY"
			? "repository sync"
			: (payload.publishedByName ?? "a teammate");
	const from =
		payload.source === "REPOSITORY"
			? ` from ${payload.sourceRef ?? "the repository"}${payload.shortCommitSha ? ` at ${payload.shortCommitSha}` : ""}`
			: "";
	const update =
		payload.update.kind === "cli_sync"
			? `Run \`${payload.update.command}\` to update your copy.`
			: `Pull ${payload.update.ref ?? "the branch"} to update your copy.`;
	const snippet = `${projectName}: published by ${by}${from}. ${update}`;
	return snippet.length <= SNIPPET_MAX_LENGTH
		? snippet
		: `${snippet.slice(0, SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}

async function writeRow(input: {
	userId: string;
	organizationId: string;
	projectId: string;
	actorUserId: string | null;
	title: string;
	snippet: string;
	payload: InstructionPublishedPayload;
}): Promise<{ id: string; userId: string } | null> {
	try {
		return await db.notification.create({
			data: {
				userId: input.userId,
				organizationId: input.organizationId,
				type: NotificationType.CODING_INSTRUCTIONS_PUBLISHED,
				category: NotificationCategory.PROJECT,
				title: input.title,
				snippet: input.snippet,
				link: `projects/${input.projectId}?tab=coding-instructions`,
				projectId: input.projectId,
				actorUserId: input.actorUserId,
				payload: input.payload,
				dedupeKey: `instructionsPublished:${input.payload.snapshotId}:${input.userId}`,
			},
			select: { id: true, userId: true },
		});
	} catch (error) {
		const code = (error as { code?: string } | null)?.code;
		if (code !== "P2002") {
			console.warn(
				"[InstructionPublishedNotification] notification write failed",
				{ snapshotId: input.payload.snapshotId, userId: input.userId },
				error,
			);
		}
		return null;
	}
}
