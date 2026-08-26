/**
 * Agent Workspace Queries
 *
 * Database operations for agent workspace files.
 * Provides CRUD operations for the virtual file system.
 */

import { db, type Prisma } from "../client";
import type { AgentFileStatus, AgentFileType } from "../generated/client";

// ============================================================================
// Types
// ============================================================================

export interface CreateWorkspaceFileInput {
	userId: string;
	organizationId?: string;
	conversationId?: string;
	path: string;
	name: string;
	content: string;
	fileType?: AgentFileType;
	extension?: string;
	mimeType?: string;
	description?: string;
	metadata?: Record<string, unknown>;
}

export interface UpdateWorkspaceFileInput {
	content?: string;
	name?: string;
	path?: string;
	status?: AgentFileStatus;
	description?: string;
	metadata?: Record<string, unknown>;
}

export interface ListWorkspaceFilesInput {
	userId: string;
	organizationId?: string;
	conversationId?: string;
	path?: string; // Filter by path prefix (folder)
	fileType?: AgentFileType;
	status?: AgentFileStatus;
	limit?: number;
	offset?: number;
}

// ============================================================================
// Create
// ============================================================================

/**
 * Create a new workspace file
 */
export async function createWorkspaceFile(input: CreateWorkspaceFileInput) {
	const {
		userId,
		organizationId,
		conversationId,
		path,
		name,
		content,
		fileType = "DOCUMENT",
		extension,
		mimeType,
		description,
		metadata,
	} = input;

	// Calculate size
	const size = Buffer.byteLength(content, "utf8");

	// Derive extension from name if not provided
	const derivedExtension = extension || name.split(".").pop() || undefined;

	// Derive mime type if not provided
	const derivedMimeType = mimeType || getMimeType(derivedExtension);

	return db.agentWorkspaceFile.create({
		data: {
			userId,
			organizationId,
			conversationId,
			path,
			name,
			content,
			size,
			fileType,
			extension: derivedExtension,
			mimeType: derivedMimeType,
			description,
			metadata: metadata as Prisma.InputJsonValue,
		},
	});
}

// ============================================================================
// Read
// ============================================================================

/**
 * Get a workspace file by ID with tenant filtering
 *
 * SECURITY: Always include tenant context to prevent ID enumeration attacks.
 * User-owned pattern: org context sees org files, personal context sees personal files.
 *
 * @param id - File ID
 * @param opts - Tenant context (userId required, organizationId optional)
 */
export async function getWorkspaceFileById(
	id: string,
	opts?: { userId: string; organizationId?: string },
) {
	// If no tenant context, return null (security: prevent ID enumeration)
	if (!opts?.userId) {
		return null;
	}

	return db.agentWorkspaceFile.findFirst({
		where: {
			id,
			userId: opts.userId,
			organizationId: opts.organizationId ?? null,
		},
	});
}

/**
 * Get a workspace file by path
 */
export async function getWorkspaceFileByPath(
	userId: string,
	path: string,
	organizationId?: string,
) {
	return db.agentWorkspaceFile.findUnique({
		where: {
			userId_organizationId_path: {
				userId,
				organizationId: organizationId || "",
				path,
			},
		},
	});
}

/**
 * List workspace files with filtering
 */
export async function listWorkspaceFiles(input: ListWorkspaceFilesInput) {
	const {
		userId,
		organizationId,
		conversationId,
		path,
		fileType,
		status,
		limit = 50,
		offset = 0,
	} = input;

	const where: Prisma.AgentWorkspaceFileWhereInput = {
		userId,
		organizationId: organizationId ?? null,
		...(conversationId && { conversationId }),
		...(path && { path: { startsWith: path } }),
		...(fileType && { fileType }),
		...(status && { status }),
	};

	const [files, total] = await Promise.all([
		db.agentWorkspaceFile.findMany({
			where,
			take: limit,
			skip: offset,
			orderBy: { updatedAt: "desc" },
			select: {
				id: true,
				path: true,
				name: true,
				extension: true,
				mimeType: true,
				size: true,
				fileType: true,
				status: true,
				description: true,
				version: true,
				createdAt: true,
				updatedAt: true,
			},
		}),
		db.agentWorkspaceFile.count({ where }),
	]);

	return { files, total };
}

/**
 * Get file tree structure for a user/org
 */
export async function getWorkspaceFileTree(
	userId: string,
	organizationId?: string,
	conversationId?: string,
) {
	const files = await db.agentWorkspaceFile.findMany({
		where: {
			userId,
			organizationId: organizationId ?? null,
			...(conversationId ? { conversationId } : {}),
			status: { not: "ARCHIVED" },
		},
		select: {
			id: true,
			path: true,
			name: true,
			extension: true,
			fileType: true,
			size: true,
			updatedAt: true,
		},
		orderBy: { path: "asc" },
	});

	// Build tree structure
	return buildFileTree(files);
}

// ============================================================================
// Update
// ============================================================================

/**
 * Update a workspace file
 */
export async function updateWorkspaceFile(
	id: string,
	input: UpdateWorkspaceFileInput,
) {
	const { content, name, path, status, description, metadata } = input;

	// Calculate new size if content changed
	const size = content ? Buffer.byteLength(content, "utf8") : undefined;

	return db.agentWorkspaceFile.update({
		where: { id },
		data: {
			...(content !== undefined && { content, size }),
			...(name !== undefined && { name }),
			...(path !== undefined && { path }),
			...(status !== undefined && { status }),
			...(description !== undefined && { description }),
			...(metadata !== undefined && {
				metadata: metadata as Prisma.InputJsonValue,
			}),
		},
	});
}

/**
 * Create a new version of a file (preserving history)
 */
export async function createFileVersion(id: string, newContent: string) {
	const existingFile = await db.agentWorkspaceFile.findUnique({
		where: { id },
	});

	if (!existingFile) {
		throw new Error(`File ${id} not found`);
	}

	// Create new version with incremented version number
	return db.agentWorkspaceFile.update({
		where: { id },
		data: {
			content: newContent,
			size: Buffer.byteLength(newContent, "utf8"),
			version: existingFile.version + 1,
		},
	});
}

// ============================================================================
// Delete
// ============================================================================

/**
 * Delete a workspace file
 */
export async function deleteWorkspaceFile(id: string) {
	return db.agentWorkspaceFile.delete({
		where: { id },
	});
}

/**
 * Archive a workspace file (soft delete)
 */
export async function archiveWorkspaceFile(id: string) {
	return db.agentWorkspaceFile.update({
		where: { id },
		data: { status: "ARCHIVED" },
	});
}

/**
 * Delete all files in a folder
 */
export async function deleteWorkspaceFolder(
	userId: string,
	folderPath: string,
	organizationId?: string,
) {
	return db.agentWorkspaceFile.deleteMany({
		where: {
			userId,
			organizationId: organizationId ?? null,
			path: { startsWith: folderPath },
		},
	});
}

// ============================================================================
// Helpers
// ============================================================================

interface FileNode {
	id: string;
	name: string;
	path: string;
	type: "file" | "folder";
	extension?: string;
	fileType?: string;
	size?: number;
	updatedAt?: Date;
	children?: FileNode[];
}

function buildFileTree(
	files: Array<{
		id: string;
		path: string;
		name: string;
		extension: string | null;
		fileType: string;
		size: number;
		updatedAt: Date;
	}>,
): FileNode[] {
	const root: FileNode[] = [];
	const folderMap = new Map<string, FileNode>();

	for (const file of files) {
		const pathParts = file.path.split("/").filter(Boolean);
		let currentPath = "";
		let currentLevel = root;

		// Create folders as needed
		for (let i = 0; i < pathParts.length - 1; i++) {
			currentPath += `/${pathParts[i]}`;

			if (!folderMap.has(currentPath)) {
				const folder: FileNode = {
					id: currentPath,
					name: pathParts[i],
					path: currentPath,
					type: "folder",
					children: [],
				};
				folderMap.set(currentPath, folder);
				currentLevel.push(folder);
			}

			const nextLevel = folderMap.get(currentPath)?.children;
			if (!nextLevel) {
				continue;
			}
			currentLevel = nextLevel;
		}

		// Add the file
		currentLevel.push({
			id: file.id,
			name: file.name,
			path: file.path,
			type: "file",
			extension: file.extension ?? undefined,
			fileType: file.fileType,
			size: file.size,
			updatedAt: file.updatedAt,
		});
	}

	return root;
}

function getMimeType(extension?: string): string | undefined {
	if (!extension) {
		return undefined;
	}

	const mimeTypes: Record<string, string> = {
		md: "text/markdown",
		txt: "text/plain",
		json: "application/json",
		js: "application/javascript",
		ts: "application/typescript",
		tsx: "application/typescript",
		jsx: "application/javascript",
		py: "text/x-python",
		html: "text/html",
		css: "text/css",
		yaml: "application/x-yaml",
		yml: "application/x-yaml",
		xml: "application/xml",
		csv: "text/csv",
		sql: "application/sql",
	};

	return mimeTypes[extension.toLowerCase()];
}
