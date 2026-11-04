import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import {
	getInstructionProposal,
	getInstructionSnapshot,
	getPublishedInstructionSnapshot,
	listInstructionFiles,
} from "@repo/database";
import {
	type ConflictReason,
	hasConflictMarkers,
	type MergeSide,
	mergeInstructionPath,
} from "@repo/instructions";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import {
	type AuditRequestContext,
	auditRequestFields,
	resolveActor,
} from "../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { MAX_CHANGES } from "./change-set";
import { requireHostingOrganizationId } from "./hosting-organization";
import { assertNoOpenMigration } from "./migration-freeze";
import {
	type InlineInstructionChange,
	submitInstructionChange,
} from "./submit-change";

const BUCKET = config.storage.bucketNames.skills;

/** A file row of one of the three versions, as the merge reads it. */
type VersionFile = {
	path: string;
	sha256: string;
	isText: boolean;
	storageKey: string;
};

/**
 * The proposer's answer for one conflicting file: its text, its removal, or
 * the published version kept, which drops the proposal's change to it.
 */
export type RebaseResolution =
	| { op: "put"; path: string; content: string }
	| { op: "delete"; path: string }
	| { op: "published"; path: string };

type RebaseConflict = {
	path: string;
	reason: ConflictReason;
	/** The file with conflict markers, or null when it cannot be shown as text. */
	text: string | null;
};

export type RebaseProposalResult =
	| {
			outcome: "conflicts";
			publishedSnapshotId: string;
			publishedVersion: number;
			conflicts: RebaseConflict[];
			/** The files that merged cleanly, and what the rebase does with each. */
			clean: Array<{ path: string; op: "put" | "delete" }>;
	  }
	| {
			outcome: "rebased";
			snapshotId: string;
			version: number;
			baseVersion: number;
			putCount: number;
			deleteCount: number;
	  }
	| {
			/**
			 * The same rebased change was already proposed on the published
			 * version, so nothing was written and the stale proposal is still
			 * pending.
			 */
			outcome: "duplicate";
			snapshotId: string;
			version: number;
	  };

function refusal(
	code: "CONFLICT" | "PRECONDITION_FAILED" | "NOT_FOUND" | "BAD_REQUEST",
	reason: string,
	message: string,
	data: Record<string, unknown> = {},
): ORPCError<string, unknown> {
	return new ORPCError(code, { message, data: { reason, ...data } });
}

async function readText(file: VersionFile): Promise<string | null> {
	if (!file.isText) {
		return null;
	}
	const { data } = await getStorageProvider().downloadFile(file.storageKey, {
		bucket: BUCKET,
	});
	return data.toString("utf8");
}

async function readBytes(file: VersionFile): Promise<Buffer> {
	const { data } = await getStorageProvider().downloadFile(file.storageKey, {
		bucket: BUCKET,
	});
	return data;
}

/**
 * One side of a path for the merge. The text is read only when both sides
 * changed the path differently, the one case the merge needs it for.
 */
async function sideOf(
	file: VersionFile | undefined,
	needsText: boolean,
): Promise<MergeSide> {
	if (!file) {
		return null;
	}
	return {
		hash: file.sha256,
		text: needsText ? await readText(file) : null,
	};
}

function byPath(files: readonly VersionFile[]): Map<string, VersionFile> {
	return new Map(files.map((file) => [file.path, file]));
}

function differs(
	a: VersionFile | undefined,
	b: VersionFile | undefined,
): boolean {
	return (a?.sha256 ?? null) !== (b?.sha256 ?? null);
}

/**
 * Rebases the proposer's stale upload-mode proposal onto the version now
 * published.
 *
 * Per file the proposal changed, against the version it was proposed on:
 * the proposal's version is carried when only it changed the file, nothing
 * is carried when the published version already holds the same change or
 * took the only change, and the two are merged line by line when both
 * changed it. A binary file, a deletion against an edit, and lines both
 * sides changed differently are conflicts.
 *
 * With no conflict left, the merged change is proposed on the published
 * version through `submitInstructionChange`, with the same validation, secret
 * scan, change-count and inline-size limits as any proposal, and the stale
 * proposal is closed in the transaction that writes the new one. With a
 * conflict, nothing is written: the conflicts come back with their markers
 * for the proposer to resolve, and a second call carries the resolutions.
 * The merge is run again then, against what is published at that moment.
 */
export async function rebaseInstructionProposal(input: {
	userId: string;
	projectId: string;
	snapshotId: string;
	resolutions: readonly RebaseResolution[];
	audit: AuditRequestContext;
}): Promise<RebaseProposalResult> {
	const organizationId = await requireHostingOrganizationId(
		input.projectId,
		input.userId,
	);
	await assertNoOpenMigration({ projectId: input.projectId, organizationId });
	// Narrowed to the caller's own proposals: another member's id answers as
	// a missing one does.
	const proposal = await getInstructionProposal(
		input.snapshotId,
		input.projectId,
		organizationId,
		{ proposerUserId: input.userId },
	);
	if (!proposal) {
		throw refusal("NOT_FOUND", "PROPOSAL_NOT_FOUND", "Proposal not found");
	}
	if (
		proposal.proposalDestination !== "FABRIC" ||
		proposal.contentKind !== "FULL_SNAPSHOT"
	) {
		throw refusal(
			"PRECONDITION_FAILED",
			"REBASE_UNSUPPORTED",
			"Only a proposal on a project that keeps its coding instructions in Fabric can be rebased.",
		);
	}
	if (proposal.proposalStatus !== "PENDING") {
		throw refusal(
			"CONFLICT",
			"REBASE_UNAVAILABLE",
			"That proposal has already been decided or canceled.",
		);
	}
	if (!proposal.isStale) {
		throw refusal(
			"CONFLICT",
			"PROPOSAL_NOT_STALE",
			"That proposal is already based on the published version.",
		);
	}
	if (proposal.status !== "READY") {
		throw refusal(
			"CONFLICT",
			"PROPOSAL_IN_PROGRESS",
			"That proposal is still being checked. Rebase it once its checks finish.",
		);
	}
	const publishedPointer = await getPublishedInstructionSnapshot(
		input.projectId,
	);
	const [base, published] = await Promise.all([
		proposal.baseSnapshotId === null
			? null
			: getInstructionSnapshot(
					proposal.baseSnapshotId,
					input.projectId,
					organizationId,
				),
		publishedPointer
			? getInstructionSnapshot(
					publishedPointer.id,
					input.projectId,
					organizationId,
				)
			: null,
	]);
	if (!published) {
		throw refusal(
			"NOT_FOUND",
			"NOTHING_PUBLISHED",
			"This project has no published coding instructions to rebase onto.",
		);
	}
	if (!base || base.status !== "READY") {
		throw refusal(
			"CONFLICT",
			"REBASE_BASE_UNAVAILABLE",
			"The version this proposal was made from is no longer kept, so it cannot be rebased. Make the change again on the published version.",
		);
	}

	const [baseFiles, proposalFiles, publishedFiles] = await Promise.all([
		listInstructionFiles(base.id, organizationId),
		listInstructionFiles(proposal.id, organizationId),
		listInstructionFiles(published.id, organizationId),
	]);
	const baseByPath = byPath(baseFiles);
	const oursByPath = byPath(proposalFiles);
	const theirsByPath = byPath(publishedFiles);
	const changedPaths = [
		...new Set([...baseByPath.keys(), ...oursByPath.keys()]),
	]
		.filter((path) => differs(baseByPath.get(path), oursByPath.get(path)))
		.sort();

	const resolutions = new Map(input.resolutions.map((r) => [r.path, r]));
	const labels = {
		ours: `your proposal (version ${proposal.version})`,
		theirs: `published (version ${published.version})`,
	};
	const changes: InlineInstructionChange[] = [];
	const clean: Array<{ path: string; op: "put" | "delete" }> = [];
	const conflicts: RebaseConflict[] = [];
	const conflictPaths = new Set<string>();
	for (const path of changedPaths) {
		const baseFile = baseByPath.get(path);
		const ours = oursByPath.get(path);
		const theirs = theirsByPath.get(path);
		const needsText = differs(baseFile, theirs) && differs(ours, theirs);
		const result = mergeInstructionPath({
			base: await sideOf(baseFile, needsText),
			ours: await sideOf(ours, needsText),
			theirs: await sideOf(theirs, needsText),
			labels,
		});
		switch (result.kind) {
			case "unchanged":
			case "take-theirs":
				break;
			case "take-ours":
				if (ours) {
					changes.push({
						op: "put",
						path,
						content: (await readBytes(ours)).toString("base64"),
						encoding: "base64",
					});
					clean.push({ path, op: "put" });
				} else {
					changes.push({ op: "delete", path });
					clean.push({ path, op: "delete" });
				}
				break;
			case "merged":
				changes.push({
					op: "put",
					path,
					content: result.text,
					encoding: "utf8",
				});
				clean.push({ path, op: "put" });
				break;
			case "conflict": {
				conflictPaths.add(path);
				const resolution = resolutions.get(path);
				if (!resolution) {
					conflicts.push({
						path,
						reason: result.reason,
						text: result.text,
					});
				} else if (resolution.op === "published") {
					// Nothing to carry: the published version stays.
				} else if (resolution.op === "delete") {
					changes.push({ op: "delete", path });
				} else {
					if (hasConflictMarkers(resolution.content)) {
						throw refusal(
							"BAD_REQUEST",
							"UNRESOLVED_CONFLICT_MARKERS",
							`Resolve every conflict in ${path} before saving: it still holds conflict markers.`,
							{ path },
						);
					}
					changes.push({
						op: "put",
						path,
						content: resolution.content,
						encoding: "utf8",
					});
				}
				break;
			}
			default: {
				const unreachable: never = result;
				throw new Error(`Unknown merge result: ${String(unreachable)}`);
			}
		}
	}
	for (const path of resolutions.keys()) {
		if (!conflictPaths.has(path)) {
			// A resolution answers a conflict and nothing else: it is not a way
			// to add a change the proposal never made.
			throw refusal(
				"BAD_REQUEST",
				"RESOLUTION_NOT_A_CONFLICT",
				`${path} has no conflict to resolve in this rebase.`,
				{ path },
			);
		}
	}
	if (conflicts.length > 0) {
		return {
			outcome: "conflicts",
			publishedSnapshotId: published.id,
			publishedVersion: published.version,
			conflicts,
			clean,
		};
	}
	if (changes.length === 0) {
		throw refusal(
			"CONFLICT",
			"REBASE_NOTHING_LEFT",
			"Everything this proposal changes is already in the published version. Cancel the proposal instead.",
		);
	}

	const requester = auditRequestFields(input.audit);
	const result = await submitInstructionChange({
		userId: input.userId,
		projectId: input.projectId,
		baseSnapshotId: published.id,
		changes,
		mode: "proposal",
		note: proposal.proposalNote ?? undefined,
		audit: input.audit,
		via: "rebase",
		supersedes: {
			snapshotId: proposal.id,
			audit: (created) => ({
				action: "project.instructions.proposal_rebased",
				category: "project",
				outcome: "success",
				actor: resolveActor(input.audit, undefined),
				organizationId,
				projectId: input.projectId,
				ipAddress: requester.ipAddress,
				userAgent: requester.userAgent,
				requestId: requester.requestId,
				sessionId: requester.sessionId,
				correlationId: requester.correlationId,
				resource: {
					type: "project_instruction_snapshot",
					id: proposal.id,
					name: `v${proposal.version}`,
				},
				metadata: {
					rebasedSnapshotId: created.id,
					rebasedVersion: created.version,
					fromBaseVersion: base.version,
					toBaseVersion: published.version,
					changeCount: changes.length,
				},
			}),
		},
	});
	// A duplicate is the one answer that closes nothing: the same rebased
	// change was already proposed, and the stale proposal is still pending.
	const after = await getInstructionProposal(
		proposal.id,
		input.projectId,
		organizationId,
		{ proposerUserId: input.userId },
	);
	if (after?.proposalStatus === "PENDING") {
		return {
			outcome: "duplicate",
			snapshotId: result.snapshotId,
			version: result.version,
		};
	}
	return {
		outcome: "rebased",
		snapshotId: result.snapshotId,
		version: result.version,
		baseVersion: result.baseVersion,
		putCount: result.putCount,
		deleteCount: result.deleteCount,
	};
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_READ), then proposer-only: the
 * proposal is read narrowed to the caller's own, and the proposal the rebase
 * writes is checked again by `submitInstructionChange` as any proposal is.
 *
 * "Rebase onto current version" for a stale upload-mode proposal. See
 * `rebaseInstructionProposal`. A repository-backed project's proposals are
 * pull requests and are refused as `REBASE_UNSUPPORTED`.
 */
export const rebaseInstructionProposalProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/proposals/:snapshotId/rebase",
		tags: ["Projects", "Instructions"],
		summary: "Rebase your stale coding-instructions proposal",
	})
	.input(
		z.object({
			projectId: z.string(),
			// Accepted for shape parity with the sibling procedures and
			// ignored: the project supplies the tenant.
			organizationId: z.string().nullable().optional(),
			snapshotId: z.string(),
			resolutions: z
				.array(
					z.discriminatedUnion("op", [
						z.object({
							op: z.literal("put"),
							path: z.string().min(1).max(4096),
							content: z.string(),
						}),
						z.object({
							op: z.literal("delete"),
							path: z.string().min(1).max(4096),
						}),
						z.object({
							op: z.literal("published"),
							path: z.string().min(1).max(4096),
						}),
					]),
				)
				.max(MAX_CHANGES)
				.default([]),
		}),
	)
	.handler(({ input, context }) =>
		rebaseInstructionProposal({
			userId: context.user.id,
			projectId: input.projectId,
			snapshotId: input.snapshotId,
			resolutions: input.resolutions,
			audit: context,
		}),
	);
