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
	rejectInstructionProposal,
} from "@repo/database";
import { SNAPSHOT_LIMITS } from "@repo/instructions";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { canReviewInstructionProposals } from "./proposal-authorization";

const BUCKET = config.storage.bucketNames.skills;
const PROPOSAL_FILE_DEFAULT_MAX = 50_000;
const PROPOSAL_FILE_MAX = 200_000;

function proposalRow(
	proposal: NonNullable<Awaited<ReturnType<typeof getInstructionProposal>>>,
	viewerUserId?: string,
) {
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
			proposal.user.id === viewerUserId &&
			proposal.proposalStatus === "PENDING" &&
			["RECEIVING", "FAILED", "READY"].includes(proposal.status),
	};
}

const proposalInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	snapshotId: z.string(),
});

export const listInstructionProposalsProcedure = tenantProtectedProcedure
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
		return {
			items: proposals.items.map((proposal) =>
				proposalRow(proposal, context.user.id),
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
			...proposalRow(proposal),
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
		| "already_decided",
): never {
	if (reason === "not_found") {
		throw new ORPCError("NOT_FOUND", { message: "Proposal not found" });
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
		return {
			approved: true as const,
			published: true as const,
			version: result.version,
		};
	});

export const rejectInstructionProposalProcedure = tenantProtectedProcedure
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
		const result = await cancelInstructionProposal({
			snapshotId: input.snapshotId,
			projectId: input.projectId,
			organizationId,
			proposerUserId: context.user.id,
			audit: decisionAudit({
				action: "project.instructions.rejected",
				context,
				organizationId,
				projectId: input.projectId,
				snapshotId: input.snapshotId,
				version: metadata?.version ?? null,
				decision: "canceled",
			}),
		});
		if (!result.ok) {
			return decisionError(result.reason);
		}
		return { canceled: true as const };
	});
