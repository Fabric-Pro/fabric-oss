import { db } from "../client";

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

export async function saveFrameEdit(
	input: SaveFrameEditInput,
): Promise<FrameEditHistoryEntry> {
	const entry = await db.frameEditHistory.create({
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
): Promise<FrameEditHistoryEntry | null> {
	// Version 0 is the current state, so we look for the Nth entry from the end
	const entries = await db.frameEditHistory.findMany({
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

export async function revertFrameToVersion(
	input: RevertFrameInput,
): Promise<RevertFrameResult> {
	// Get the historical version
	const historyEntry = await getFrameEditByVersion(
		input.frameId,
		input.toVersion,
	);

	if (!historyEntry || !historyEntry.contentSnapshot) {
		return {
			success: false,
			error: `Version ${input.toVersion} not found or has no snapshot`,
		};
	}

	// Verify ownership
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
			error: "Frame not found",
		};
	}

	// Save revert action to history
	await saveFrameEdit({
		frameId: input.frameId,
		editType: "revert",
		contentSnapshot: historyEntry.contentSnapshot,
		editedBy: input.userId,
		revertedToVersion: input.toVersion,
	});

	// Restore content
	await db.agentWorkspaceFile.update({
		where: { id: input.frameId },
		data: {
			content: historyEntry.contentSnapshot,
			size: Buffer.byteLength(historyEntry.contentSnapshot, "utf8"),
		},
	});

	return {
		success: true,
		newContent: historyEntry.contentSnapshot,
	};
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
