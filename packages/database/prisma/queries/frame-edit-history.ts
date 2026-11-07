import { throwIfDispatchStopped } from "@repo/utils/dispatch-guard";
import { db, type Prisma } from "../client";
import { recordAuditTx } from "./audit-log";
import { preserveLegacyFramePublication } from "./frame-approved-revisions";
import { FrameDocumentSchema } from "./frame-document";
import { canAccessFrameProject } from "./frame-project-access";
import {
	assertFrameRevision,
	FrameUpdateConflictError,
	nextFrameRevision,
} from "./frame-revision";
import { canWriteReportDerivedFrame } from "./report-frame-access";

export interface SaveFrameEditInput {
	frameId: string;
	editType: "string_replace" | "full_update" | "revert";
	oldString?: string;
	newString?: string;
	contentSnapshot?: string;
	editedBy: string;
	revertedToVersion?: number;
}

export interface FrameEditHistoryEntry {
	id: string;
	frameId: string;
	editType: string;
	oldString: string | null;
	newString: string | null;
	contentSnapshot: string | null;
	editedBy: string;
	editedAt: Date;
	revertedToVersion: number | null;
}

/**
 * Records one edit. Inside a transaction, pass its client as `client` so the
 * row is part of it; on its own the row is written at once.
 */
export async function saveFrameEdit(
	input: SaveFrameEditInput,
	client: Pick<Prisma.TransactionClient, "frameEditHistory"> = db,
): Promise<FrameEditHistoryEntry> {
	const entry = await client.frameEditHistory.create({
		data: {
			frameId: input.frameId,
			editType: input.editType,
			oldString: input.oldString,
			newString: input.newString,
			contentSnapshot: input.contentSnapshot,
			editedBy: input.editedBy,
			editedAt: new Date(),
			revertedToVersion: input.revertedToVersion,
		},
	});

	return {
		id: entry.id,
		frameId: entry.frameId,
		editType: entry.editType,
		oldString: entry.oldString,
		newString: entry.newString,
		contentSnapshot: entry.contentSnapshot,
		editedBy: entry.editedBy,
		editedAt: entry.editedAt,
		revertedToVersion: entry.revertedToVersion,
	};
}

export async function getFrameEditHistory(
	frameId: string,
	limit = 50,
): Promise<FrameEditHistoryEntry[]> {
	const entries = await db.frameEditHistory.findMany({
		where: { frameId },
		orderBy: [{ editedAt: "desc" }, { id: "desc" }],
		take: limit,
	});

	return entries.map((entry) => ({
		id: entry.id,
		frameId: entry.frameId,
		editType: entry.editType,
		oldString: entry.oldString,
		newString: entry.newString,
		contentSnapshot: entry.contentSnapshot,
		editedBy: entry.editedBy,
		editedAt: entry.editedAt,
		revertedToVersion: entry.revertedToVersion,
	}));
}

export async function getFrameEditByVersion(
	frameId: string,
	version: number,
	client: Pick<Prisma.TransactionClient, "frameEditHistory"> = db,
): Promise<FrameEditHistoryEntry | null> {
	// Version 0 is the current state, so we look for the Nth entry from the end
	const entries = await client.frameEditHistory.findMany({
		where: { frameId },
		orderBy: [{ editedAt: "asc" }, { id: "asc" }],
		skip: version - 1,
		take: 1,
	});

	const entry = entries[0];
	if (!entry) {
		return null;
	}

	return {
		id: entry.id,
		frameId: entry.frameId,
		editType: entry.editType,
		oldString: entry.oldString,
		newString: entry.newString,
		contentSnapshot: entry.contentSnapshot,
		editedBy: entry.editedBy,
		editedAt: entry.editedAt,
		revertedToVersion: entry.revertedToVersion,
	};
}

export interface EditFrameStringInput {
	frameId: string;
	userId: string;
	organizationId?: string;
	expectedUpdatedAt?: Date;
	oldString: string;
	newString: string;
	expectedReplacements?: number;
}

export interface EditFrameStringResult {
	success: boolean;
	replacementsMade: number;
	newContent: string;
	error?: string;
}

export async function editFrameString(
	input: EditFrameStringInput,
): Promise<EditFrameStringResult> {
	// Get current frame content
	const frame = await db.agentWorkspaceFile.findFirst({
		where: {
			id: input.frameId,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			fileType: { in: ["FRAME", "SLIDESHOW"] },
		},
	});

	if (
		!frame ||
		!(await canAccessFrameProject(frame, input.userId, true)) ||
		!(await canWriteReportDerivedFrame(frame, input))
	) {
		return {
			success: false,
			replacementsMade: 0,
			newContent: "",
			error: "Frame not found",
		};
	}

	const content = frame.content;

	// Count occurrences
	const occurrences = content.split(input.oldString).length - 1;

	if (occurrences === 0) {
		return {
			success: false,
			replacementsMade: 0,
			newContent: content,
			error: "String not found in frame content",
		};
	}

	const expected = input.expectedReplacements ?? 1;

	if (occurrences !== expected) {
		return {
			success: false,
			replacementsMade: occurrences,
			newContent: content,
			error: `Expected ${expected} replacement(s), but found ${occurrences} occurrence(s)`,
		};
	}

	// Perform replacement
	const newContent = content.split(input.oldString).join(input.newString);

	try {
		const before = JSON.parse(content);
		const after = JSON.parse(newContent);
		if (
			!FrameDocumentSchema.safeParse(after).success ||
			JSON.stringify(before.metadata) !==
				JSON.stringify(after.metadata) ||
			JSON.stringify(before.theme?.branding ?? null) !==
				JSON.stringify(after.theme?.branding ?? null)
		) {
			return {
				success: false,
				replacementsMade: 0,
				newContent: content,
				error: "String edits must preserve a valid page, its tool access and branding. Use the content editor or reviewed Branding action instead.",
			};
		}
	} catch {
		return {
			success: false,
			replacementsMade: 0,
			newContent: content,
			error: "String edit would break the page document.",
		};
	}
	// A legacy string edit is still a compare-and-swap, and its snapshot is restorable.
	assertFrameRevision(input.expectedUpdatedAt, frame.updatedAt);
	throwIfDispatchStopped();
	const committed = await db
		.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM agent_workspace_file WHERE id = ${input.frameId} FOR UPDATE`;
			await preserveLegacyFramePublication(tx, frame);
			if (
				!(await canAccessFrameProject(frame, input.userId, true, tx)) ||
				!(await canWriteReportDerivedFrame(frame, input, tx))
			) {
				return false;
			}
			await saveFrameEdit(
				{
					frameId: input.frameId,
					editType: "string_replace",
					oldString: input.oldString,
					newString: input.newString,
					contentSnapshot: frame.content,
					editedBy: input.userId,
				},
				tx,
			);
			const updated = await tx.agentWorkspaceFile.update({
				where: {
					id: input.frameId,
					updatedAt: input.expectedUpdatedAt ?? frame.updatedAt,
				},
				data: {
					content: newContent,
					size: Buffer.byteLength(newContent, "utf8"),
					updatedAt: nextFrameRevision(frame.updatedAt),
				},
			});
			if (input.organizationId) {
				await recordAuditTx(tx, {
					action: "frame.updated",
					organizationId: input.organizationId,
					actor: { type: "user", userId: input.userId },
					resource: { type: "frame", id: input.frameId },
					projectId: frame.projectId,
					metadata: {
						revision: updated.updatedAt.toISOString(),
						editType: "string_replace",
					},
				});
			}
			return true;
		})
		.catch((error: unknown) => {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "P2025"
			) {
				throw new FrameUpdateConflictError();
			}
			throw error;
		});

	if (!committed) {
		return {
			success: false,
			replacementsMade: 0,
			newContent: content,
			error: "Frame not found",
		};
	}
	return {
		success: true,
		replacementsMade: occurrences,
		newContent,
	};
}

export interface RevertFrameInput {
	frameId: string;
	userId: string;
	organizationId?: string;
	toVersion?: number;
	historyEntryId?: string;
	expectedUpdatedAt?: Date;
}

export interface RevertFrameResult {
	success: boolean;
	newContent?: string;
	updatedAt?: string;
	error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * The page as it was at `snapshot`, declaring the Fabric tools the page
 * declares NOW. The tools a page may call are part of the document, and the
 * set in force is the one a person last confirmed: an older version restored
 * as it was could bring back tools nobody has approved since, so a restore
 * never widens what a page can do. Null when either document is not a JSON
 * object, which nothing here can restore safely.
 */
function restoredDocument(snapshot: string, current: string): string | null {
	let before: Record<string, unknown> | null;
	let now: Record<string, unknown> | null;
	try {
		before = asRecord(JSON.parse(snapshot));
		now = asRecord(JSON.parse(current));
	} catch {
		return null;
	}
	if (!before || !now) {
		return null;
	}
	const { runtime: _historic, ...metadata } = asRecord(before.metadata) ?? {};
	const runtime = asRecord(asRecord(now.metadata)?.runtime);
	const next = { ...metadata, ...(runtime ? { runtime } : {}) };
	// Restore content, never an older brand selection. Applying a different
	// saved brand requires the reviewed Branding command and current authority.
	const { branding: _historicBrand, ...theme } = asRecord(before.theme) ?? {};
	const branding = asRecord(asRecord(now.theme)?.branding);
	const nextTheme = { ...theme, ...(branding ? { branding } : {}) };
	return JSON.stringify(
		{
			...before,
			...(before.theme !== undefined || branding
				? { theme: nextTheme }
				: {}),
			...(before.metadata !== undefined || runtime
				? { metadata: next }
				: {}),
		},
		null,
		2,
	);
}

/**
 * Puts a frame back as it was before its `toVersion`th change. The history row
 * that keeps what the revert replaces and the content update stand or fall
 * together, and a second revert of the same page waits for the first.
 */
export async function revertFrameToVersion(
	input: RevertFrameInput,
): Promise<RevertFrameResult> {
	return db.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT "id" FROM "agent_workspace_file" WHERE "id" = ${input.frameId} FOR UPDATE`;

		// Verify ownership
		const frame = await tx.agentWorkspaceFile.findFirst({
			where: {
				id: input.frameId,
				userId: input.userId,
				organizationId: input.organizationId ?? null,
				fileType: { in: ["FRAME", "SLIDESHOW"] },
			},
		});

		if (
			!frame ||
			!(await canAccessFrameProject(frame, input.userId, true, tx)) ||
			!(await canWriteReportDerivedFrame(frame, input, tx))
		) {
			return {
				success: false,
				error: "Frame not found",
			};
		}

		assertFrameRevision(input.expectedUpdatedAt, frame.updatedAt);
		await preserveLegacyFramePublication(tx, frame);
		const historyEntry = input.historyEntryId
			? await tx.frameEditHistory.findFirst({
					where: { id: input.historyEntryId, frameId: input.frameId },
				})
			: input.toVersion
				? await getFrameEditByVersion(
						input.frameId,
						input.toVersion,
						tx,
					)
				: null;

		if (!historyEntry || !historyEntry.contentSnapshot) {
			return {
				success: false,
				error: input.historyEntryId
					? "Saved version not found or has no snapshot"
					: `Version ${input.toVersion} not found or has no snapshot`,
			};
		}

		const restored = restoredDocument(
			historyEntry.contentSnapshot,
			frame.content,
		);
		const restoredPage =
			restored === null
				? null
				: FrameDocumentSchema.safeParse(JSON.parse(restored));
		if (restored === null || !restoredPage?.success) {
			return {
				success: false,
				error: input.historyEntryId
					? "Saved version cannot be restored"
					: `Version ${input.toVersion} cannot be restored`,
			};
		}

		// Save revert action to history. Like every other entry it holds the content
		// the edit replaced, so a revert can itself be undone.
		await saveFrameEdit(
			{
				frameId: input.frameId,
				editType: "revert",
				contentSnapshot: frame.content,
				editedBy: input.userId,
				revertedToVersion: input.toVersion,
			},
			tx,
		);

		throwIfDispatchStopped();
		const updated = await tx.agentWorkspaceFile.update({
			where: { id: input.frameId, updatedAt: frame.updatedAt },
			data: {
				updatedAt: nextFrameRevision(frame.updatedAt),
				name: `${restoredPage.data.title}.frame.json`,
				description: restoredPage.data.description ?? null,
				content: restored,
				size: Buffer.byteLength(restored, "utf8"),
			},
		});

		if (input.organizationId) {
			await recordAuditTx(tx, {
				action: "frame.restored",
				organizationId: input.organizationId,
				actor: { type: "user", userId: input.userId },
				resource: { type: "frame", id: input.frameId },
				projectId: frame.projectId,
				metadata: {
					historyEntryId: historyEntry.id,
					revision: updated.updatedAt.toISOString(),
				},
			});
		}
		return {
			success: true,
			updatedAt: updated.updatedAt.toISOString(),
			newContent: restored,
		};
	});
}

export async function saveFullUpdateToHistory(
	frameId: string,
	oldContent: string,
	_newContent: string,
	editedBy: string,
): Promise<void> {
	await saveFrameEdit({
		frameId,
		editType: "full_update",
		contentSnapshot: oldContent,
		editedBy,
	});
}
