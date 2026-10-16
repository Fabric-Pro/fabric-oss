import { db, type Prisma } from "../client";

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
		orderBy: { editedAt: "desc" },
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
		orderBy: { editedAt: "asc" },
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

	if (!frame) {
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

	// Save edit to history
	await saveFrameEdit({
		frameId: input.frameId,
		editType: "string_replace",
		oldString: input.oldString,
		newString: input.newString,
		editedBy: input.userId,
	});

	// Update frame content
	await db.agentWorkspaceFile.update({
		where: { id: input.frameId },
		data: {
			content: newContent,
			size: Buffer.byteLength(newContent, "utf8"),
		},
	});

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
	toVersion: number;
}

export interface RevertFrameResult {
	success: boolean;
	newContent?: string;
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
	return JSON.stringify(
		{
			...before,
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

		if (!frame) {
			return {
				success: false,
				error: "Frame not found",
			};
		}

		const historyEntry = await getFrameEditByVersion(
			input.frameId,
			input.toVersion,
			tx,
		);

		if (!historyEntry || !historyEntry.contentSnapshot) {
			return {
				success: false,
				error: `Version ${input.toVersion} not found or has no snapshot`,
			};
		}

		const restored = restoredDocument(
			historyEntry.contentSnapshot,
			frame.content,
		);
		if (restored === null) {
			return {
				success: false,
				error: `Version ${input.toVersion} cannot be restored`,
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

		await tx.agentWorkspaceFile.update({
			where: { id: input.frameId },
			data: {
				content: restored,
				size: Buffer.byteLength(restored, "utf8"),
			},
		});

		return {
			success: true,
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
