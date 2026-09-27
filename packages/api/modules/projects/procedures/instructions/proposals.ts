import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import {
	approveInstructionProposal,
	cancelInstructionProposal,
	getInstructionFileByPath,
	getInstructionProposal,
	getInstructionSnapshot,
	listInstructionFiles,
	listInstructionProposals,
	proposalBranchIdOf,
	rejectInstructionProposal,
} from "@repo/database";
import { SNAPSHOT_LIMITS } from "@repo/instructions";
import { warmInstructionSnapshotExport } from "@repo/instructions/export";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import { auditRequestFields, resolveActor } from "../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { runInBackground } from "../../../weave/lib/run-in-background";
import { requireHostingOrganizationId } from "./hosting-organization";
import { canReviewInstructionProposals } from "./proposal-authorization";
import { wakeBranchAfterCommand } from "./proposal-branch";
import {
	getProposalPullRequestStatus,
	type MergeSyncReceipts,
	type ProposalBranchAttachments,
	type ProposalPullRequestRequester,
	pullRequestStatusOf,
	readBranchAttachments,
	readMergeSyncReceipts,
	refreshProposalPullRequest,
	retryProposalPullRequest,
} from "./proposal-pull-request";

const BUCKET = config.storage.bucketNames.skills;
const PROPOSAL_FILE_DEFAULT_MAX = 50_000;
const PROPOSAL_FILE_MAX = 200_000;

/** The stored note's two fields, as the admission schema wrote them. */
function noteOf(value: unknown): { title?: string; body?: string } | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const { title, body } = value as { title?: unknown; body?: unknown };
	const note = {
		...(typeof title === "string" ? { title } : {}),
		...(typeof body === "string" ? { body } : {}),
	};
	return Object.keys(note).length > 0 ? note : null;
}

/**
 * One proposal as the tab and the CLI show it. A REPOSITORY proposal adds
 * where it goes, its note and its pull request (Fizzy #2563 spec §12); a
 * FABRIC one has `pullRequest: null`. `canCancel` stays false once closing
 * is requested: a second cancel would change nothing, and it also reads
 * false once a branch proposal's pull request settles (`proposalStatus`
 * is then derived from the terminal `pullRequestState`, never `PENDING`).
 *
 * `isProposer` is the ownership half of that same rule, without the
 * in-progress narrowing: it stays true on a settled row, so a terminal,
 * unverified branch proposal can still offer "Propose again" (Fizzy #2738
 * spec Decision 14) to its own author even though `canCancel` is false
 * there. It mirrors the check `proposeAgain` enforces at
 * `instruction-proposal-branch-commands.ts` (`snapshot.userId ===
 * proposerUserId`).
 */
async function proposalRow(
	proposal: NonNullable<Awaited<ReturnType<typeof getInstructionProposal>>>,
	scope: { projectId: string; organizationId: string },
	viewerUserId?: string,
	receipts?: MergeSyncReceipts,
	attachments?: ProposalBranchAttachments,
) {
	const isProposer = proposal.user.id === viewerUserId;
	return {
		id: proposal.id,
		version: proposal.version,
		baseVersion: proposal.baseVersion,
		status: proposal.status,
		proposalStatus: proposal.proposalStatus,
		createdAt: proposal.createdAt,
		readyAt: proposal.readyAt,
		proposer: proposal.user,
		reviewer: proposal.reviewer,
		reviewedAt: proposal.reviewedAt,
		isStale: proposal.isStale,
		canCancel:
			isProposer &&
			proposal.proposalStatus === "PENDING" &&
			proposal.pullRequestState !== "CLOSE_REQUESTED" &&
			["RECEIVING", "FAILED", "READY"].includes(proposal.status),
		isProposer,
		destination: proposal.proposalDestination,
		note: noteOf(proposal.proposalNote),
		pullRequest: await pullRequestStatusOf(
			proposal,
			scope,
			receipts,
			attachments,
		),
	};
}

const proposalInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	snapshotId: z.string(),
});

export const listInstructionProposalsProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/proposals",
		tags: ["Projects", "Instructions"],
		summary: "List coding-instructions file proposals",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			cursor: z.string().optional(),
			limit: z.number().int().min(1).max(50).default(25),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const canReview = await canReviewInstructionProposals({
			projectId: input.projectId,
			userId: context.user.id,
		});
		const proposals = await listInstructionProposals(
			input.projectId,
			organizationId,
			{
				limit: input.limit,
				cursor: input.cursor,
				proposerUserId: canReview ? undefined : context.user.id,
			},
		);
		const scope = { projectId: input.projectId, organizationId };
		// One receipt query for the page, not one per merged row: the tab
		// polls this list while a dialog is open.
		// The same for the member branch blocks (Fizzy #2738 spec §10).
		const attachments = await readBranchAttachments(proposals.items, scope);
		const receipts = await readMergeSyncReceipts(
			proposals.items,
			scope,
			attachments,
		);
		return {
			items: await Promise.all(
				proposals.items.map((proposal) =>
					proposalRow(
						proposal,
						scope,
						context.user.id,
						receipts,
						attachments,
					),
				),
			),
			nextCursor: proposals.nextCursor,
		};
	});

type DiffFile = Awaited<ReturnType<typeof listInstructionFiles>>[number];

const MAX_PROPOSAL_DIFF_INLINE_BYTES = SNAPSHOT_LIMITS.maxInlineTextBytes;

type OmissionReason = "BINARY" | "FILE_TOO_LARGE" | "RESPONSE_LIMIT" | null;

async function buildProposalChanges(input: {
	proposal: NonNullable<Awaited<ReturnType<typeof getInstructionProposal>>>;
	projectId: string;
	organizationId: string;
}) {
	const baseSnapshotId = input.proposal.baseSnapshotId;
	if (!baseSnapshotId) {
		throw new ORPCError("NOT_FOUND", {
			message: "The proposal base is no longer available",
		});
	}
	const base = await getInstructionSnapshot(
		baseSnapshotId,
		input.projectId,
		input.organizationId,
	);
	if (!base || base.status !== "READY") {
		throw new ORPCError("NOT_FOUND", {
			message: "The proposal base is no longer available",
		});
	}
	const [beforeFiles, afterFiles] = await Promise.all([
		listInstructionFiles(base.id, input.organizationId),
		listInstructionFiles(input.proposal.id, input.organizationId),
	]);
	const beforeByPath = new Map(beforeFiles.map((file) => [file.path, file]));
	const afterByPath = new Map(afterFiles.map((file) => [file.path, file]));
	const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
		.filter(
			(path) =>
				beforeByPath.get(path)?.sha256 !==
				afterByPath.get(path)?.sha256,
		)
		.sort((a, b) => a.localeCompare(b));

	const changes = [];
	let remainingBytes = MAX_PROPOSAL_DIFF_INLINE_BYTES;
	async function inlineBody(file: DiffFile | undefined): Promise<{
		text: string | null;
		omitted: OmissionReason;
		size: number | null;
	}> {
		if (!file) {
			return { text: null, omitted: null, size: null };
		}
		if (!file.isText) {
			return { text: null, omitted: "BINARY", size: file.size };
		}
		if (file.size > SNAPSHOT_LIMITS.maxInlineTextBytes) {
			return {
				text: null,
				omitted: "FILE_TOO_LARGE",
				size: file.size,
			};
		}
		if (file.size > remainingBytes) {
			return { text: null, omitted: "RESPONSE_LIMIT", size: file.size };
		}
		// Reserve before I/O so the response budget cannot be raced by parallel
		// downloads if this loop is refactored later.
		remainingBytes -= file.size;
		const { data } = await getStorageProvider().downloadFile(
			file.storageKey,
			{
				bucket: BUCKET,
			},
		);
		if (data.byteLength > SNAPSHOT_LIMITS.maxInlineTextBytes) {
			return {
				text: null,
				omitted: "FILE_TOO_LARGE",
				size: data.byteLength,
			};
		}
		const extraBytes = data.byteLength - file.size;
		if (extraBytes > remainingBytes) {
			return {
				text: null,
				omitted: "RESPONSE_LIMIT",
				size: data.byteLength,
			};
		}
		remainingBytes -= Math.max(0, extraBytes);
		return {
			text: data.toString("utf8"),
			omitted: null,
			size: data.byteLength,
		};
	}
	for (const path of paths) {
		const beforeFile = beforeByPath.get(path);
		const afterFile = afterByPath.get(path);
		const binary =
			(beforeFile !== undefined && !beforeFile.isText) ||
			(afterFile !== undefined && !afterFile.isText);
		const binarySide = (file: DiffFile | undefined) => ({
			text: null,
			omitted: file ? ("BINARY" as const) : null,
			size: file?.size ?? null,
		});
		const before = binary
			? binarySide(beforeFile)
			: await inlineBody(beforeFile);
		const after = binary
			? binarySide(afterFile)
			: await inlineBody(afterFile);
		changes.push({
			path,
			op: beforeFile
				? afterFile
					? ("edit" as const)
					: ("delete" as const)
				: ("add" as const),
			before: before.text,
			after: after.text,
			beforeOmitted: before.omitted,
			afterOmitted: after.omitted,
			beforeSize: before.size,
			afterSize: after.size,
			binary,
		});
	}
	return changes;
}

export const getInstructionProposalProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_UPDATE))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/proposals/:snapshotId",
		tags: ["Projects", "Instructions"],
		summary: "Get one coding-instructions file proposal",
	})
	.input(proposalInput)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const proposal = await getInstructionProposal(
			input.snapshotId,
			input.projectId,
			organizationId,
		);
		if (!proposal) {
			throw new ORPCError("NOT_FOUND", { message: "Proposal not found" });
		}
		return {
			...(await proposalRow(
				proposal,
				{
					projectId: input.projectId,
					organizationId,
				},
				context.user.id,
			)),
			changes:
				proposal.status === "READY"
					? await buildProposalChanges({
							proposal,
							projectId: input.projectId,
							organizationId,
						})
					: null,
		};
	});

export const getInstructionProposalFileProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_UPDATE))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/proposals/:snapshotId/file",
		tags: ["Projects", "Instructions"],
		summary: "Read one changed text side of a coding-instructions proposal",
	})
	.input(
		proposalInput.extend({
			path: z.string().max(4096),
			side: z.enum(["before", "after"]),
			offset: z.number().int().min(0).default(0),
			maxLength: z
				.number()
				.int()
				.min(1)
				.max(PROPOSAL_FILE_MAX)
				.default(PROPOSAL_FILE_DEFAULT_MAX),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const proposal = await getInstructionProposal(
			input.snapshotId,
			input.projectId,
			organizationId,
		);
		if (
			!proposal ||
			proposal.status !== "READY" ||
			proposal.baseSnapshotId === null
		) {
			throw new ORPCError("NOT_FOUND", {
				message: "Proposal file not found",
			});
		}
		const base = await getInstructionSnapshot(
			proposal.baseSnapshotId,
			input.projectId,
			organizationId,
		);
		if (!base || base.status !== "READY") {
			throw new ORPCError("NOT_FOUND", {
				message: "Proposal file not found",
			});
		}
		const [before, after] = await Promise.all([
			getInstructionFileByPath(base.id, organizationId, input.path),
			getInstructionFileByPath(proposal.id, organizationId, input.path),
		]);
		if (
			(!before && !after) ||
			before?.sha256 === after?.sha256 ||
			(input.side === "before" && !before) ||
			(input.side === "after" && !after)
		) {
			throw new ORPCError("NOT_FOUND", {
				message: "Proposal file not found",
			});
		}
		const file = input.side === "before" ? before : after;
		if (!file?.isText) {
			throw new ORPCError("NOT_FOUND", {
				message: "Proposal file not found",
			});
		}
		const { data } = await getStorageProvider().downloadFile(
			file.storageKey,
			{
				bucket: BUCKET,
			},
		);
		const chars = Array.from(data.toString("utf8"));
		const body = chars
			.slice(input.offset, input.offset + input.maxLength)
			.join("");
		const end = input.offset + input.maxLength;
		const truncated = end < chars.length;
		return {
			path: input.path,
			side: input.side,
			body,
			offset: input.offset,
			nextOffset: truncated ? end : null,
			truncated,
			size: data.byteLength,
			mimeType: file.mimeType,
		};
	});

function decisionAudit(input: {
	action: "project.instructions.published" | "project.instructions.rejected";
	context: {
		user: { id: string; email: string; name?: string | null };
		session?: { impersonatedBy?: string | null } | null;
	};
	organizationId: string;
	projectId: string;
	snapshotId: string;
	version: number | null;
	decision: "approved" | "rejected" | "canceled";
}) {
	return {
		action: input.action,
		category: "project",
		severity:
			input.decision !== "approved"
				? ("warning" as const)
				: ("info" as const),
		outcome: "success" as const,
		actor: {
			type: "user" as const,
			userId: input.context.user.id,
			emailSnapshot: input.context.user.email,
			nameSnapshot: input.context.user.name ?? null,
			impersonatedById: input.context.session?.impersonatedBy ?? null,
		},
		organizationId: input.organizationId,
		projectId: input.projectId,
		resource: {
			type: "project_instruction_snapshot",
			id: input.snapshotId,
			name: input.version === null ? null : `v${input.version}`,
		},
		metadata: { source: "file_proposal_review", decision: input.decision },
	};
}

function decisionError(
	reason:
		| "not_found"
		| "not_ready"
		| "in_progress"
		| "stale"
		| "already_decided"
		| "repository_backed"
		| "repository_proposal",
): never {
	if (reason === "not_found") {
		throw new ORPCError("NOT_FOUND", { message: "Proposal not found" });
	}
	if (reason === "repository_proposal") {
		// Fizzy #2563 spec §12: a REPOSITORY proposal is decided on its pull
		// request, in the repository, never here.
		throw new ORPCError("PRECONDITION_FAILED", {
			message:
				"This suggestion is a pull request in the project's repository. Review and merge or close it there.",
			data: { reason: "REPOSITORY_PROPOSAL" },
		});
	}
	if (reason === "repository_backed") {
		// Spec §4: the same refusal `derive-snapshot.ts` gives an edit.
		throw new ORPCError("PRECONDITION_FAILED", {
			message:
				"This project's coding instructions come from its repository. Change the files there and sync the project.",
			data: { reason: "REPOSITORY_BACKED" },
		});
	}
	if (reason === "not_ready") {
		throw new ORPCError("PRECONDITION_FAILED", {
			message: "Only a proposal that passed validation can be reviewed",
			data: { reason: "PROPOSAL_NOT_READY" },
		});
	}
	if (reason === "in_progress") {
		throw new ORPCError("CONFLICT", {
			message:
				"This proposal is being validated. Try again after the current check finishes.",
			data: { reason: "PROPOSAL_IN_PROGRESS" },
		});
	}
	throw new ORPCError("CONFLICT", {
		message:
			reason === "stale"
				? "The published instructions changed. Resubmit this proposal from the current version."
				: "This proposal already has a different decision",
		data: {
			reason:
				reason === "stale"
					? "PROPOSAL_STALE"
					: "PROPOSAL_ALREADY_DECIDED",
		},
	});
}

export const approveInstructionProposalProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/proposals/:snapshotId/approve",
		tags: ["Projects", "Instructions"],
		summary: "Approve and publish a coding-instructions file proposal",
	})
	.input(proposalInput)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const metadata = await getInstructionProposal(
			input.snapshotId,
			input.projectId,
			organizationId,
		);
		const result = await approveInstructionProposal({
			snapshotId: input.snapshotId,
			projectId: input.projectId,
			organizationId,
			reviewerUserId: context.user.id,
			audit: decisionAudit({
				action: "project.instructions.published",
				context,
				organizationId,
				projectId: input.projectId,
				snapshotId: input.snapshotId,
				version: metadata?.version ?? null,
				decision: "approved",
			}),
		});
		if (!result.ok) {
			return decisionError(result.reason);
		}
		// Approving a proposal publishes it, so the same pre-build the manual
		// publish procedure schedules applies here: the proposal id IS the
		// snapshot id, and the archive that the next `fabric instructions
		// sync` asks for is built now rather than inside that request.
		// Scheduled through `runInBackground` and never awaited, so the
		// reviewer's response is unchanged; the helper never throws, and a
		// warm that fails only costs the first downloader the old wait.
		runInBackground(
			warmInstructionSnapshotExport({
				projectId: input.projectId,
				organizationId,
				snapshotId: input.snapshotId,
			}),
		);
		return {
			approved: true as const,
			published: true as const,
			version: result.version,
		};
	});

export const rejectInstructionProposalProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/proposals/:snapshotId/reject",
		tags: ["Projects", "Instructions"],
		summary: "Reject a coding-instructions file proposal",
	})
	.input(proposalInput)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const metadata = await getInstructionProposal(
			input.snapshotId,
			input.projectId,
			organizationId,
		);
		const result = await rejectInstructionProposal({
			snapshotId: input.snapshotId,
			projectId: input.projectId,
			organizationId,
			reviewerUserId: context.user.id,
			audit: decisionAudit({
				action: "project.instructions.rejected",
				context,
				organizationId,
				projectId: input.projectId,
				snapshotId: input.snapshotId,
				version: metadata?.version ?? null,
				decision: "rejected",
			}),
		});
		if (!result.ok) {
			return decisionError(result.reason);
		}
		return { rejected: true as const };
	});

export const cancelInstructionProposalProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/proposals/:snapshotId/cancel",
		tags: ["Projects", "Instructions"],
		summary: "Cancel your coding-instructions file proposal",
	})
	.input(proposalInput)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const metadata = await getInstructionProposal(
			input.snapshotId,
			input.projectId,
			organizationId,
		);
		// A REPOSITORY cancel also writes `pull_request_close_requested` from
		// this row's actor and request fields (spec §13.4), so the request
		// half rides along; the actor stays `decisionAudit`'s.
		const { actor: _actor, ...request } = requesterOf(context);
		const result = await cancelInstructionProposal({
			snapshotId: input.snapshotId,
			projectId: input.projectId,
			organizationId,
			proposerUserId: context.user.id,
			audit: {
				...decisionAudit({
					action: "project.instructions.rejected",
					context,
					organizationId,
					projectId: input.projectId,
					snapshotId: input.snapshotId,
					version: metadata?.version ?? null,
					decision: "canceled",
				}),
				...request,
			},
		});
		if (!result.ok) {
			if (result.withdrawBlocked) {
				return withdrawBlockedError(result.withdrawBlocked);
			}
			return decisionError(result.reason);
		}
		// A member branch withdrawal (Fizzy #2738 spec §6.8) committed a
		// command the branch workflow carries out: a revert, the branch's
		// close, or a queue that moved on. Wake it; a lost wake is the
		// sweeper's.
		if (result.scope !== undefined && result.changed) {
			await wakeBranchAfterCommand(
				await proposalBranchIdOf({
					snapshotId: input.snapshotId,
					organizationId,
				}),
				{
					projectId: input.projectId,
					organizationId,
					userId: context.user.id,
				},
			);
		}
		// `canceled` when nothing had been pushed or created, `close_requested`
		// when Fabric now closes what it opened, null for a FABRIC proposal.
		return { canceled: true as const, pullRequest: result.pullRequest };
	});

/**
 * WITHDRAW_BLOCKED_BY_LATER_CHANGE (spec §6.8, §9): a later change on the
 * member's branch wrote one of this change's files, so it cannot be
 * withdrawn alone. 409, naming the paths (the first 20) and their count.
 */
function withdrawBlockedError(blocked: {
	paths: string[];
	count: number;
}): never {
	throw new ORPCError("CONFLICT", {
		message: `A later change on your branch also edits ${blocked.paths.join(", ")}${
			blocked.count > blocked.paths.length
				? ` and ${blocked.count - blocked.paths.length} more`
				: ""
		}, so this change cannot be withdrawn on its own. Close the pull request to withdraw everything, or edit the branch in the repository.`,
		data: {
			reason: "WITHDRAW_BLOCKED_BY_LATER_CHANGE",
			paths: blocked.paths,
			count: blocked.count,
		},
	});
}

/** The retry's and cancel's audit request half, from this request. */
function requesterOf(
	context: Parameters<typeof auditRequestFields>[0],
): ProposalPullRequestRequester {
	const { impersonatedById: _impersonatedById, ...request } =
		auditRequestFields(context);
	return { actor: resolveActor(context, undefined), ...request };
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_READ),
 * then the live proposer-or-reviewer check in the service (plan Decision 8).
 *
 * A REPOSITORY proposal's pull request as the row records it (spec §12): the
 * card polls this. Never asks the provider. `pullRequest: null` for a FABRIC
 * proposal.
 */
export const getInstructionProposalPullRequestProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
		.route({
			method: "GET",
			path: "/projects/:projectId/instructions/proposals/:snapshotId/pull-request",
			tags: ["Projects", "Instructions"],
			summary: "Get a coding-instructions proposal's pull request",
		})
		.input(proposalInput)
		.handler(async ({ input, context }) => {
			const organizationId = await requireHostingOrganizationId(
				input.projectId,
				context.user.id,
			);
			return {
				pullRequest: await getProposalPullRequestStatus({
					snapshotId: input.snapshotId,
					projectId: input.projectId,
					organizationId,
					userId: context.user.id,
				}),
			};
		});

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_READ),
 * then the live proposer-or-reviewer check in the service (plan Decision 8).
 *
 * Refresh (spec §12): the row's check time is cleared and a retryable
 * BLOCKED row made due, and the operation's workflow is started or adopted
 * for a row it moves. `refreshed: false` for a settled row. Admitted once a
 * minute per operation and never over a provider's rate-limit deadline; a
 * refused Refresh is TOO_MANY_REQUESTS with `data.retryAfter` and the same
 * `Retry-After` header the RPC rate limiter sends.
 */
export const refreshInstructionProposalPullRequestProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
		.route({
			method: "POST",
			path: "/projects/:projectId/instructions/proposals/:snapshotId/pull-request/refresh",
			tags: ["Projects", "Instructions"],
			summary:
				"Check a coding-instructions proposal's pull request again",
		})
		.input(proposalInput)
		.handler(async ({ input, context }) => {
			const organizationId = await requireHostingOrganizationId(
				input.projectId,
				context.user.id,
			);
			try {
				return await refreshProposalPullRequest({
					snapshotId: input.snapshotId,
					projectId: input.projectId,
					organizationId,
					userId: context.user.id,
				});
			} catch (error) {
				const retryAfter =
					error instanceof ORPCError &&
					error.code === "TOO_MANY_REQUESTS"
						? (error.data as { retryAfter?: unknown } | undefined)
								?.retryAfter
						: undefined;
				if (typeof retryAfter === "number") {
					context.resHeaders?.set("Retry-After", String(retryAfter));
				}
				throw error;
			}
		});

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_READ),
 * then the live proposer-or-reviewer check in the service: the spec's
 * "proposer or INSTRUCTION_UPDATE" (plan Decision 8).
 *
 * "Retry opening the pull request" (spec §12) on a BLOCKED row only a human
 * may re-issue. `expectedAttempt` is the attempt the card showed; a row that
 * moved since is a CONFLICT.
 */
export const retryInstructionProposalPullRequestProcedure =
	tenantProtectedProcedure
		.use(projectNotFoundUnlessVisible)
		.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
		.route({
			method: "POST",
			path: "/projects/:projectId/instructions/proposals/:snapshotId/pull-request/retry",
			tags: ["Projects", "Instructions"],
			summary:
				"Retry opening a coding-instructions proposal's pull request",
		})
		.input(
			proposalInput.extend({
				expectedAttempt: z.number().int().min(0),
			}),
		)
		.handler(async ({ input, context }) => {
			const organizationId = await requireHostingOrganizationId(
				input.projectId,
				context.user.id,
			);
			return retryProposalPullRequest({
				snapshotId: input.snapshotId,
				projectId: input.projectId,
				organizationId,
				userId: context.user.id,
				expectedAttempt: input.expectedAttempt,
				requester: requesterOf(context),
			});
		});
