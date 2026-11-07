import { contentIdentity } from "@repo/utils/content-identity";
import { db, type Prisma } from "../client";
import type { AgentWorkspaceFile } from "../generated/client";
import { FrameDocumentSchema } from "./frame-document";
import { FrameUpdateConflictError } from "./frame-revision";

export class FramePublicationError extends Error {
	constructor() {
		super(
			"This page is too large for a shared snapshot. Make it private before editing or split it into smaller pages.",
		);
		this.name = "FramePublicationError";
	}
}
export const FRAME_APPROVED_POINTER = "approvedFrameRevisionId";
export const FRAME_PUBLISHED_POINTER = "publishedFrameRevisionId";
export function frameMetadata(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
/** Internal only: caller holds the parent Frame row lock and has authorized the operation. */
export async function saveFrameApprovedSnapshot(
	tx: Prisma.TransactionClient,
	file: AgentWorkspaceFile,
	origin: "APPROVED" | "LEGACY_PUBLICATION",
) {
	if (!file.organizationId) {
		throw new Error("Frame organization is required.");
	}
	if (Buffer.byteLength(file.content, "utf8") > 8_000_000) {
		throw new FramePublicationError();
	}
	FrameDocumentSchema.parse(JSON.parse(file.content));
	const contentHash = contentIdentity(file.content);
	const id = `frame-approved-${contentIdentity(JSON.stringify([file.id, contentHash, origin]))}`;
	const existing = await tx.frameApprovedRevision.findFirst({
		where: {
			id,
			frameId: file.id,
			userId: file.userId,
			organizationId: file.organizationId,
		},
	});
	if (existing) {
		return existing;
	}
	return tx.frameApprovedRevision.create({
		data: {
			id,
			frameId: file.id,
			userId: file.userId,
			organizationId: file.organizationId,
			contentHash,
			content: file.content,
			sourceUpdatedAt: file.updatedAt,
			origin,
		},
	});
}
/** Preserve an existing public version before the first draft edit, without inventing review. */
export async function preserveLegacyFramePublication(
	tx: Prisma.TransactionClient,
	previous: AgentWorkspaceFile,
) {
	const current = await tx.agentWorkspaceFile.findFirst({
		where: {
			id: previous.id,
			userId: previous.userId,
			organizationId: previous.organizationId,
		},
	});
	if (
		!current ||
		current.updatedAt.getTime() !== previous.updatedAt.getTime() ||
		current.content !== previous.content
	) {
		throw new FrameUpdateConflictError();
	}
	const file = current;
	if (
		!file.isPublic ||
		Object.hasOwn(frameMetadata(file.metadata), FRAME_PUBLISHED_POINTER)
	) {
		return;
	}
	const snapshot = await saveFrameApprovedSnapshot(
		tx,
		file,
		"LEGACY_PUBLICATION",
	);
	await tx.agentWorkspaceFile.update({
		where: { id: previous.id, updatedAt: file.updatedAt },
		data: {
			metadata: {
				...frameMetadata(file.metadata),
				[FRAME_PUBLISHED_POINTER]: snapshot.id,
			} as Prisma.InputJsonValue,
			updatedAt: file.updatedAt,
		},
	});
}
/** A broken publication pointer never falls back to an unreviewed mutable draft. */
export async function publicFrameSnapshot(file: AgentWorkspaceFile) {
	const pointer = frameMetadata(file.metadata)[FRAME_PUBLISHED_POINTER];
	if (pointer === undefined) {
		try {
			return FrameDocumentSchema.safeParse(JSON.parse(file.content))
				.success
				? file
				: null;
		} catch {
			return null;
		}
	}
	if (typeof pointer !== "string") {
		return null;
	}
	const snapshot = await db.frameApprovedRevision.findFirst({
		where: {
			id: pointer,
			frameId: file.id,
			organizationId: file.organizationId!,
			userId: file.userId,
		},
	});
	if (
		!snapshot ||
		contentIdentity(snapshot.content) !== snapshot.contentHash
	) {
		return null;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(snapshot.content);
	} catch {
		return null;
	}
	const parsed = FrameDocumentSchema.safeParse(raw);
	if (!parsed.success) {
		return null;
	}
	return {
		...file,
		content: snapshot.content,
		updatedAt: snapshot.sourceUpdatedAt,
		name: `${parsed.data.title}.frame.json`,
		description: parsed.data.description ?? null,
		size: Buffer.byteLength(snapshot.content, "utf8"),
	};
}
