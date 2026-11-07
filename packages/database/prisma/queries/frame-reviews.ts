import { contentIdentity } from "@repo/utils/content-identity";
import {
	FRAME_REVIEW_MAX_BYTES,
	type FrameChangeProposalView,
	type FrameReviewDocument,
	frameApplyChangeSchema,
	frameApproveRevisionSchema,
	frameChangeIdentitySchema,
	frameProposalListSchema,
	frameProposeChangeSchema,
	summarizeFrameChange,
} from "@repo/utils/frame-review-contracts";
import { db, type Prisma } from "../client";
import type {
	FrameApprovedRevision,
	FrameChangeProposal,
} from "../generated/client";
import { recordAuditTx } from "./audit-log";
import {
	FRAME_APPROVED_POINTER,
	FRAME_PUBLISHED_POINTER,
	frameMetadata,
	saveFrameApprovedSnapshot,
} from "./frame-approved-revisions";
import { FrameDocumentSchema } from "./frame-document";
import { canAccessFrameProject } from "./frame-project-access";
import { frameDocumentForEdit, updateFrame } from "./frames";
import {
	canReadOrganizationFrames,
	canUpdateOrganizationFrames,
} from "./organization-permissions";
import {
	canReadReportDerivedFrame,
	canWriteReportDerivedFrame,
} from "./report-frame-access";

export interface FrameReviewActor {
	userId: string;
	organizationId: string;
	boundProjectId?: string;
	auditActorType?: "user" | "api_key" | "agent";
	transport?: "portal" | "api" | "mcp";
}
export class FrameReviewError extends Error {
	constructor(
		public readonly code:
			| "NOT_FOUND"
			| "FORBIDDEN"
			| "CONFLICT"
			| "BAD_REQUEST"
			| "PAYLOAD_TOO_LARGE",
		message: string,
	) {
		super(message);
		this.name = "FrameReviewError";
	}
}
async function target(
	actor: FrameReviewActor,
	frameId: string,
	write = false,
	tx: Prisma.TransactionClient = db,
) {
	if (!actor.organizationId || !actor.userId) {
		throw new FrameReviewError(
			"NOT_FOUND",
			"Page not found or access denied.",
		);
	}
	if (
		!(await (write
			? canUpdateOrganizationFrames
			: canReadOrganizationFrames)(
			actor.userId,
			actor.organizationId,
			tx,
		))
	) {
		throw new FrameReviewError(
			"FORBIDDEN",
			"Your current role cannot perform this page operation.",
		);
	}
	const file = await tx.agentWorkspaceFile.findFirst({
		where: {
			id: frameId,
			userId: actor.userId,
			organizationId: actor.organizationId,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
	});
	if (
		!file ||
		(actor.boundProjectId && file.projectId !== actor.boundProjectId)
	) {
		throw new FrameReviewError(
			"NOT_FOUND",
			"Page not found or access denied.",
		);
	}
	if (!(await canAccessFrameProject(file, actor.userId, write, tx))) {
		throw new FrameReviewError(
			"NOT_FOUND",
			"Page not found or access denied.",
		);
	}

	if (
		!(await (write
			? canWriteReportDerivedFrame
			: canReadReportDerivedFrame)(file, actor, tx))
	) {
		throw new FrameReviewError(
			"NOT_FOUND",
			"Page not found or access denied.",
		);
	}
	return file;
}
function bound(content: string) {
	if (Buffer.byteLength(content, "utf8") > FRAME_REVIEW_MAX_BYTES) {
		throw new FrameReviewError(
			"PAYLOAD_TOO_LARGE",
			"This page is too large for a reviewed change. Keep the review under 1 MB.",
		);
	}
}
function viewDocument(content: string): FrameReviewDocument {
	const d = FrameDocumentSchema.parse(JSON.parse(content));
	return {
		title: d.title,
		description: d.description,
		presentation: d.presentation,
		blocks: d.blocks,
		theme: d.theme,
	};
}
function view(
	row: FrameChangeProposal,
	currentUpdatedAt: Date,
): FrameChangeProposalView {
	const base = viewDocument(row.baseContent);
	const proposed = viewDocument(row.proposedContent);
	return {
		id: row.id,
		frameId: row.frameId,
		status: row.status as FrameChangeProposalView["status"],
		baseUpdatedAt: row.baseUpdatedAt.toISOString(),
		baseContentHash: row.baseContentHash,
		proposedContentHash: row.proposedContentHash,
		createdAt: row.createdAt.toISOString(),
		appliedUpdatedAt: row.appliedUpdatedAt?.toISOString() ?? null,
		summary: summarizeFrameChange(base, proposed),
		base,
		proposed,
		currentUpdatedAt: currentUpdatedAt.toISOString(),
		conflicted:
			row.status === "PENDING" &&
			row.baseUpdatedAt.getTime() !== currentUpdatedAt.getTime(),
	};
}
const scope = (actor: FrameReviewActor, frameId: string) => ({
	frameId,
	userId: actor.userId,
	organizationId: actor.organizationId,
});
const revision = (row: FrameApprovedRevision | null) =>
	row
		? {
				id: row.id,
				contentHash: row.contentHash,
				sourceUpdatedAt: row.sourceUpdatedAt.toISOString(),
				createdAt: row.createdAt.toISOString(),
				origin: row.origin as "APPROVED" | "LEGACY_PUBLICATION",
			}
		: null;
async function audit(
	tx: Prisma.TransactionClient,
	actor: FrameReviewActor,
	frame: { id: string; projectId: string | null },
	action:
		| "frame.change_proposed"
		| "frame.change_applied"
		| "frame.change_dismissed"
		| "frame.approved",
	metadata: Record<string, string | boolean>,
) {
	await recordAuditTx(tx, {
		action,
		organizationId: actor.organizationId,
		actor: { type: actor.auditActorType ?? "user", userId: actor.userId },
		resource: { type: "frame", id: frame.id },
		projectId: frame.projectId,
		metadata: { ...metadata, transport: actor.transport ?? "portal" },
	});
}
export async function proposeFrameChange(
	actor: FrameReviewActor,
	frameId: string,
	raw: unknown,
) {
	const input = frameProposeChangeSchema.parse(raw);
	const requestHash = contentIdentity(JSON.stringify(input));
	const id = `frame-change-${contentIdentity(JSON.stringify([actor.organizationId, actor.userId, frameId, input.requestId]))}`;
	await target(actor, frameId, true);
	return db.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM agent_workspace_file WHERE id=${frameId} FOR UPDATE`;
		const file = await target(actor, frameId, true, tx);
		const existing = await tx.frameChangeProposal.findFirst({
			where: { id, ...scope(actor, frameId) },
		});
		if (existing) {
			if (existing.requestHash !== requestHash) {
				throw new FrameReviewError(
					"CONFLICT",
					"This request ID already identifies a different proposed change.",
				);
			}
			return { ...view(existing, file.updatedAt), replayed: true };
		}
		if (file.updatedAt.toISOString() !== input.expectedUpdatedAt) {
			throw new FrameReviewError(
				"CONFLICT",
				"The page changed. Read its current version before proposing a change.",
			);
		}
		if (
			(await tx.frameChangeProposal.count({
				where: { ...scope(actor, frameId), status: "PENDING" },
			})) >= 20
		) {
			throw new FrameReviewError(
				"BAD_REQUEST",
				"Review or dismiss pending changes before proposing more.",
			);
		}
		bound(file.content);
		const document = frameDocumentForEdit(
			FrameDocumentSchema.parse(JSON.parse(file.content)),
			input.edit,
			file.sourceRunType,
		);
		const proposedContent = JSON.stringify(document, null, 2);
		bound(proposedContent);
		if (proposedContent === file.content) {
			throw new FrameReviewError(
				"BAD_REQUEST",
				"This proposal does not change the saved page.",
			);
		}
		const row = await tx.frameChangeProposal.create({
			data: {
				id,
				...scope(actor, frameId),
				requestId: input.requestId,
				requestHash,
				baseUpdatedAt: file.updatedAt,
				baseContentHash: contentIdentity(file.content),
				baseContent: file.content,
				proposedContent,
				proposedContentHash: contentIdentity(proposedContent),
			},
		});
		await audit(tx, actor, file, "frame.change_proposed", {
			proposalId: row.id,
			baseRevision: input.expectedUpdatedAt,
		});
		return { ...view(row, file.updatedAt), replayed: false };
	});
}
export async function listFrameChanges(
	actor: FrameReviewActor,
	frameId: string,
	raw: unknown = {},
) {
	const input = frameProposalListSchema.parse(raw);
	const file = await target(actor, frameId);
	const rows = await db.frameChangeProposal.findMany({
		where: scope(actor, frameId),
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		skip: input.offset,
		take: input.limit + 1,
	});
	return {
		proposals: rows.slice(0, input.limit).map((row) => {
			const {
				base: _,
				proposed: __,
				...summary
			} = view(row, file.updatedAt);
			return summary;
		}),
		hasMore: rows.length > input.limit,
	};
}
export async function getFrameChange(
	actor: FrameReviewActor,
	frameId: string,
	raw: unknown,
) {
	const input = frameChangeIdentitySchema.parse(raw);
	const file = await target(actor, frameId);
	const row = await db.frameChangeProposal.findFirst({
		where: { id: input.proposalId, ...scope(actor, frameId) },
	});
	if (!row) {
		throw new FrameReviewError("NOT_FOUND", "Proposed change not found.");
	}
	return view(row, file.updatedAt);
}
export async function applyFrameChange(
	actor: FrameReviewActor,
	frameId: string,
	raw: unknown,
) {
	const input = frameApplyChangeSchema.parse(raw);
	await target(actor, frameId, true);
	return db.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM agent_workspace_file WHERE id=${frameId} FOR UPDATE`;
		const file = await target(actor, frameId, true, tx);
		const row = await tx.frameChangeProposal.findFirst({
			where: { id: input.proposalId, ...scope(actor, frameId) },
		});
		if (!row) {
			throw new FrameReviewError(
				"NOT_FOUND",
				"Proposed change not found.",
			);
		}
		if (
			row.proposedContentHash !== input.expectedProposalHash ||
			contentIdentity(row.proposedContent) !== row.proposedContentHash
		) {
			throw new FrameReviewError(
				"CONFLICT",
				"The proposed content does not match the version you reviewed.",
			);
		}
		if (row.status === "APPLIED") {
			return {
				proposalId: row.id,
				appliedUpdatedAt: row.appliedUpdatedAt?.toISOString(),
				currentUpdatedAt: file.updatedAt.toISOString(),
				replayed: true,
			};
		}
		if (row.status !== "PENDING") {
			throw new FrameReviewError(
				"CONFLICT",
				"This change was dismissed and cannot be applied.",
			);
		}
		if (
			row.baseUpdatedAt.getTime() !== file.updatedAt.getTime() ||
			row.baseContentHash !== contentIdentity(file.content)
		) {
			throw new FrameReviewError(
				"CONFLICT",
				"The page changed after this proposal. Your proposal is preserved; compare it with the current page before creating a new review.",
			);
		}
		const d = FrameDocumentSchema.parse(JSON.parse(row.proposedContent));
		const saved = await updateFrame(
			{
				id: frameId,
				userId: actor.userId,
				organizationId: actor.organizationId,
				expectedUpdatedAt: row.baseUpdatedAt,
				title: d.title,
				description: d.description,
				blocks: d.blocks,
				presentation: d.presentation,
				theme: d.theme,
			},
			tx,
		);
		if (!saved) {
			throw new FrameReviewError(
				"NOT_FOUND",
				"Page not found or access denied.",
			);
		}
		await tx.frameChangeProposal.update({
			where: { id: row.id },
			data: { status: "APPLIED", appliedUpdatedAt: saved.updatedAt },
		});
		await audit(tx, actor, file, "frame.change_applied", {
			proposalId: row.id,
			revision: saved.updatedAt.toISOString(),
		});
		return {
			proposalId: row.id,
			appliedUpdatedAt: saved.updatedAt.toISOString(),
			currentUpdatedAt: saved.updatedAt.toISOString(),
			replayed: false,
		};
	});
}
export async function dismissFrameChange(
	actor: FrameReviewActor,
	frameId: string,
	raw: unknown,
) {
	const input = frameChangeIdentitySchema.parse(raw);
	await target(actor, frameId, true);
	return db.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM agent_workspace_file WHERE id=${frameId} FOR UPDATE`;
		const file = await target(actor, frameId, true, tx);
		const row = await tx.frameChangeProposal.findFirst({
			where: { id: input.proposalId, ...scope(actor, frameId) },
		});
		if (!row) {
			throw new FrameReviewError(
				"NOT_FOUND",
				"Proposed change not found.",
			);
		}
		if (row.status === "APPLIED") {
			throw new FrameReviewError(
				"CONFLICT",
				"This change was already applied. Use version history to restore the page.",
			);
		}
		if (row.status !== "DISMISSED") {
			await tx.frameChangeProposal.update({
				where: { id: row.id },
				data: { status: "DISMISSED" },
			});
			await audit(tx, actor, file, "frame.change_dismissed", {
				proposalId: row.id,
			});
		}
		return { proposalId: row.id, status: "DISMISSED" as const };
	});
}
export async function getFrameReviewState(
	actor: FrameReviewActor,
	frameId: string,
) {
	const file = await target(actor, frameId);
	const metadata = frameMetadata(file.metadata);
	const ids = [
		metadata[FRAME_APPROVED_POINTER],
		metadata[FRAME_PUBLISHED_POINTER],
	].filter((v): v is string => typeof v === "string");
	const rows = ids.length
		? await db.frameApprovedRevision.findMany({
				where: { ...scope(actor, frameId), id: { in: ids } },
			})
		: [];
	const approved =
		rows.find(
			(r) =>
				r.id === metadata[FRAME_APPROVED_POINTER] &&
				r.origin === "APPROVED",
		) ?? null;
	const published =
		rows.find((r) => r.id === metadata[FRAME_PUBLISHED_POINTER]) ?? null;
	const currentContentHash = contentIdentity(file.content);
	return {
		frameId,
		currentUpdatedAt: file.updatedAt.toISOString(),
		currentContentHash,
		approved: revision(approved),
		published: revision(published),
		hasPublicLink: file.isPublic && Boolean(file.shareToken),
		hasUnapprovedChanges: approved?.contentHash !== currentContentHash,
		hasUnpublishedChanges: published?.contentHash !== currentContentHash,
	};
}
export async function approveFrameRevision(
	actor: FrameReviewActor,
	frameId: string,
	raw: unknown,
) {
	const input = frameApproveRevisionSchema.parse(raw);
	await target(actor, frameId, true);
	await db.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM agent_workspace_file WHERE id=${frameId} FOR UPDATE`;
		const file = await target(actor, frameId, true, tx);
		if (
			file.updatedAt.toISOString() !== input.expectedUpdatedAt ||
			contentIdentity(file.content) !== input.expectedContentHash
		) {
			throw new FrameReviewError(
				"CONFLICT",
				"The page changed. Review its current version before approving.",
			);
		}
		bound(file.content);
		const snapshot = await saveFrameApprovedSnapshot(tx, file, "APPROVED");
		if (
			frameMetadata(file.metadata)[FRAME_APPROVED_POINTER] !== snapshot.id
		) {
			await tx.agentWorkspaceFile.update({
				where: { id: file.id, updatedAt: file.updatedAt },
				data: {
					metadata: {
						...frameMetadata(file.metadata),
						[FRAME_APPROVED_POINTER]: snapshot.id,
					} as Prisma.InputJsonValue,
					updatedAt: file.updatedAt,
				},
			});
			await audit(tx, actor, file, "frame.approved", {
				revision: input.expectedUpdatedAt,
				contentHash: input.expectedContentHash,
			});
		}
	});
	return getFrameReviewState(actor, frameId);
}
