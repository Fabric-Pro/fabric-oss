/**
 * Agent Memory Database Queries
 *
 * Virtual filesystem operations for agent memory (COALA framework).
 * Supports procedural (AGENTS.md), semantic (skills, knowledge), and episodic (conversations) memory.
 */

import { createHash } from "node:crypto";
import { db } from "../client";
import type {
	AgentMemoryEdit,
	AgentMemoryEditOperation,
	AgentMemoryEditStatus,
	AgentMemoryFile,
	AgentMemoryFileType,
	Prisma,
} from "../generated/client";

// Re-export types for external use
export type {
	AgentMemoryFile,
	AgentMemoryEdit,
	AgentMemoryFileType,
	AgentMemoryEditOperation,
	AgentMemoryEditStatus,
};

// ============================================
// TYPES
// ============================================

export interface MemoryFileContext {
	agentInstanceId?: string;
	userId: string;
	organizationId?: string | null;
}

export interface ListMemoryFilesParams extends MemoryFileContext {
	path?: string; // Filter by path prefix (e.g., "skills/")
	fileType?: AgentMemoryFileType;
	limit?: number;
	offset?: number;
}

export interface MemoryFileWithMeta extends AgentMemoryFile {
	pendingEdits?: number;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Generate SHA-256 hash for content change detection
 */
export function generateContentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Determine file type from path
 */
export function getFileTypeFromPath(path: string): AgentMemoryFileType {
	const normalizedPath = path.toLowerCase();

	if (normalizedPath === "agents.md") {
		return "AGENTS_MD";
	}
	if (normalizedPath === "mcp.json" || normalizedPath === "tools.json") {
		return "MCP_JSON";
	}
	if (
		normalizedPath.startsWith("skills/") &&
		normalizedPath.endsWith(".md")
	) {
		return "SKILL";
	}
	if (normalizedPath.startsWith("knowledge/")) {
		return "KNOWLEDGE";
	}
	if (
		normalizedPath.startsWith("conversations/") &&
		normalizedPath.endsWith(".json")
	) {
		return "CONVERSATION";
	}
	return "CUSTOM";
}

/**
 * Build tenant filter for XOR pattern isolation
 */
function buildTenantFilter(
	ctx: MemoryFileContext,
): Prisma.AgentMemoryFileWhereInput {
	if (ctx.agentInstanceId) {
		return {
			agentInstanceId: ctx.agentInstanceId,
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? null,
		};
	}
	// For non-instance memory (future: orchestrator-level memory)
	return {
		agentInstanceId: null,
		userId: ctx.userId,
		organizationId: ctx.organizationId ?? null,
	};
}

// ============================================
// FILE OPERATIONS
// ============================================

/**
 * List memory files for an agent instance
 */
export async function listMemoryFiles(
	params: ListMemoryFilesParams,
): Promise<{ files: MemoryFileWithMeta[]; total: number }> {
	const { path, fileType, limit = 100, offset = 0, ...ctx } = params;

	const where: Prisma.AgentMemoryFileWhereInput = {
		...buildTenantFilter(ctx),
	};

	if (path) {
		where.path = { startsWith: path };
	}
	if (fileType) {
		where.fileType = fileType;
	}

	const [files, total] = await Promise.all([
		db.agentMemoryFile.findMany({
			where,
			orderBy: { path: "asc" },
			skip: offset,
			take: limit,
		}),
		db.agentMemoryFile.count({ where }),
	]);

	// Add pending edit counts
	const filesWithMeta: MemoryFileWithMeta[] = await Promise.all(
		files.map(async (file) => {
			const pendingEdits = await db.agentMemoryEdit.count({
				where: {
					memoryFileId: file.id,
					status: "PENDING",
				},
			});
			return { ...file, pendingEdits };
		}),
	);

	return { files: filesWithMeta, total };
}

/**
 * Read a memory file by path
 */
export async function readMemoryFile(
	ctx: MemoryFileContext,
	path: string,
): Promise<AgentMemoryFile | null> {
	return db.agentMemoryFile.findFirst({
		where: {
			...buildTenantFilter(ctx),
			path,
		},
	});
}

/**
 * Check if a memory file exists
 */
export async function memoryFileExists(
	ctx: MemoryFileContext,
	path: string,
): Promise<boolean> {
	const count = await db.agentMemoryFile.count({
		where: {
			...buildTenantFilter(ctx),
			path,
		},
	});
	return count > 0;
}

/**
 * Create or update a memory file
 * Returns the file and whether it was created
 */
export async function writeMemoryFile(
	ctx: MemoryFileContext,
	path: string,
	content: string,
	modifiedBy: "user" | "agent" | "system",
	options?: { isEnabled?: boolean; sourceSkillId?: string },
): Promise<{ file: AgentMemoryFile; created: boolean }> {
	const contentHash = generateContentHash(content);
	const fileType = getFileTypeFromPath(path);

	const existing = await readMemoryFile(ctx, path);

	if (existing) {
		// Update existing file
		const updateData: Record<string, unknown> = {
			content,
			contentHash,
			version: { increment: 1 },
			lastModifiedBy: modifiedBy,
			isValid: true,
			validationError: null,
		};
		if (options?.isEnabled !== undefined) {
			updateData.isEnabled = options.isEnabled;
		}
		if (options?.sourceSkillId !== undefined) {
			updateData.sourceSkillId = options.sourceSkillId;
		}
		const updated = await db.agentMemoryFile.update({
			where: { id: existing.id },
			data: updateData,
		});
		return { file: updated, created: false };
	}

	// Create new file
	const created = await db.agentMemoryFile.create({
		data: {
			agentInstanceId: ctx.agentInstanceId,
			userId: ctx.userId,
			organizationId: ctx.organizationId,
			path,
			fileType,
			content,
			contentHash,
			lastModifiedBy: modifiedBy,
			...(options?.isEnabled !== undefined && {
				isEnabled: options.isEnabled,
			}),
			...(options?.sourceSkillId !== undefined && {
				sourceSkillId: options.sourceSkillId,
			}),
		},
	});
	return { file: created, created: true };
}

/**
 * Delete a memory file
 */
export async function deleteMemoryFile(
	ctx: MemoryFileContext,
	path: string,
): Promise<boolean> {
	const file = await readMemoryFile(ctx, path);
	if (!file) {
		return false;
	}

	await db.agentMemoryFile.delete({
		where: { id: file.id },
	});
	return true;
}

/**
 * Search memory files by content
 */
export async function searchMemoryFiles(
	ctx: MemoryFileContext,
	query: string,
	options?: { fileTypes?: AgentMemoryFileType[]; limit?: number },
): Promise<AgentMemoryFile[]> {
	const { fileTypes, limit = 20 } = options || {};

	const where: Prisma.AgentMemoryFileWhereInput = {
		...buildTenantFilter(ctx),
		content: { contains: query, mode: "insensitive" },
	};

	if (fileTypes && fileTypes.length > 0) {
		where.fileType = { in: fileTypes };
	}

	return db.agentMemoryFile.findMany({
		where,
		orderBy: { updatedAt: "desc" },
		take: limit,
	});
}

// ============================================
// EDIT/APPROVAL OPERATIONS
// ============================================

/**
 * Create a pending memory edit (for HITL approval)
 */
export async function createMemoryEdit(params: {
	ctx: MemoryFileContext;
	path: string;
	operation: AgentMemoryEditOperation;
	newContent: string;
	reason?: string;
	autoApprove?: boolean;
}): Promise<AgentMemoryEdit> {
	const {
		ctx,
		path,
		operation,
		newContent,
		reason,
		autoApprove = false,
	} = params;

	// Get existing file for UPDATE/DELETE operations
	const existingFile = await readMemoryFile(ctx, path);
	const oldContent = existingFile?.content ?? null;

	// Determine status based on auto-approve
	const status: AgentMemoryEditStatus = autoApprove
		? "AUTO_APPROVED"
		: "PENDING";

	const edit = await db.agentMemoryEdit.create({
		data: {
			memoryFileId: existingFile?.id,
			agentInstanceId: ctx.agentInstanceId,
			userId: ctx.userId,
			organizationId: ctx.organizationId,
			operation,
			path,
			oldContent,
			newContent,
			reason,
			status,
			autoApproved: autoApprove,
			approvedAt: autoApprove ? new Date() : null,
		},
	});

	// If auto-approved, apply the edit immediately
	if (autoApprove) {
		await applyMemoryEdit(edit.id, ctx.userId);
	}

	return edit;
}

/**
 * List pending edits for an agent instance
 */
export async function listPendingEdits(
	ctx: MemoryFileContext,
): Promise<AgentMemoryEdit[]> {
	return db.agentMemoryEdit.findMany({
		where: {
			agentInstanceId: ctx.agentInstanceId,
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? null,
			status: "PENDING",
		},
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Get a specific edit by ID
 */
export async function getMemoryEdit(
	editId: string,
): Promise<AgentMemoryEdit | null> {
	return db.agentMemoryEdit.findUnique({
		where: { id: editId },
	});
}

/**
 * Approve and apply a memory edit
 */
export async function approveMemoryEdit(
	editId: string,
	approvedBy: string,
): Promise<{ edit: AgentMemoryEdit; file: AgentMemoryFile | null }> {
	const edit = await db.agentMemoryEdit.update({
		where: { id: editId },
		data: {
			status: "APPROVED",
			approvedBy,
			approvedAt: new Date(),
		},
	});

	const file = await applyMemoryEdit(editId, approvedBy);

	return { edit, file };
}

/**
 * Reject a memory edit
 */
export async function rejectMemoryEdit(
	editId: string,
	rejectedBy: string,
	reason?: string,
): Promise<AgentMemoryEdit> {
	return db.agentMemoryEdit.update({
		where: { id: editId },
		data: {
			status: "REJECTED",
			approvedBy: rejectedBy, // Reuse field for who rejected
			approvedAt: new Date(),
			rejectionReason: reason,
		},
	});
}

/**
 * Apply a memory edit to the actual file
 * Internal function - called after approval
 */
async function applyMemoryEdit(
	editId: string,
	_modifiedBy: string,
): Promise<AgentMemoryFile | null> {
	const edit = await db.agentMemoryEdit.findUnique({
		where: { id: editId },
	});

	if (!edit) {
		throw new Error(`Edit ${editId} not found`);
	}

	const ctx: MemoryFileContext = {
		agentInstanceId: edit.agentInstanceId ?? undefined,
		userId: edit.userId,
		organizationId: edit.organizationId,
	};

	switch (edit.operation) {
		case "CREATE":
		case "UPDATE": {
			const { file } = await writeMemoryFile(
				ctx,
				edit.path,
				edit.newContent,
				"agent",
			);
			return file;
		}
		case "DELETE": {
			await deleteMemoryFile(ctx, edit.path);
			return null;
		}
		default:
			throw new Error(`Unknown operation: ${edit.operation}`);
	}
}

// ============================================
// INITIALIZATION & EXPORT
// ============================================

/**
 * Initialize memory files from an agent template
 * Creates AGENTS.md from template instructions
 */
export async function initializeMemoryFromTemplate(params: {
	agentInstanceId: string;
	templateId: string;
	userId: string;
	organizationId?: string | null;
}): Promise<AgentMemoryFile[]> {
	const { agentInstanceId, templateId, userId, organizationId } = params;

	// Get the template
	const template = await db.agentTemplate.findUnique({
		where: { id: templateId },
	});

	if (!template) {
		throw new Error(`Template ${templateId} not found`);
	}

	const ctx: MemoryFileContext = {
		agentInstanceId,
		userId,
		organizationId,
	};

	const createdFiles: AgentMemoryFile[] = [];

	// Create AGENTS.md from template instructions
	const agentsMdContent = buildAgentsMdFromTemplate(template);
	const { file: agentsMd } = await writeMemoryFile(
		ctx,
		"AGENTS.md",
		agentsMdContent,
		"system",
	);
	createdFiles.push(agentsMd);

	// Materialize template skills as instance SKILL memory files
	const templateSkills = await db.agentTemplateSkill.findMany({
		where: { templateId },
		include: { skill: true },
		orderBy: { sortOrder: "asc" },
	});

	for (const ts of templateSkills) {
		const skillPath = `skills/${ts.skill.slug}/SKILL.md`;
		const { file } = await writeMemoryFile(
			ctx,
			skillPath,
			ts.skill.content,
			"system",
			{ isEnabled: true, sourceSkillId: ts.skillId },
		);
		createdFiles.push(file);
	}

	return createdFiles;
}

/**
 * Build AGENTS.md content from template instructions
 */
function buildAgentsMdFromTemplate(template: {
	name: string;
	displayName: string;
	description: string;
	instructions: string;
}): string {
	let content = `# ${template.displayName}\n\n`;
	content += `${template.description}\n\n`;
	if (template.instructions.trim()) {
		content += `${template.instructions.trim()}\n\n`;
	}

	return content.trim();
}

/**
 * Export all memory files for an instance as a flat object
 * Useful for backup/restore or portability
 */
export async function exportMemory(
	ctx: MemoryFileContext,
): Promise<Record<string, string>> {
	const { files } = await listMemoryFiles({ ...ctx, limit: 1000 });

	const exported: Record<string, string> = {};
	for (const file of files) {
		exported[file.path] = file.content;
	}

	return exported;
}

/**
 * Import memory files from a flat object
 * Overwrites existing files
 */
export async function importMemory(
	ctx: MemoryFileContext,
	files: Record<string, string>,
): Promise<AgentMemoryFile[]> {
	const imported: AgentMemoryFile[] = [];

	for (const [path, content] of Object.entries(files)) {
		const { file } = await writeMemoryFile(ctx, path, content, "system");
		imported.push(file);
	}

	return imported;
}

// ============================================
// VALIDATION
// ============================================

/**
 * Validate AGENTS.md content
 * Must be valid markdown with at least a title
 */
export function validateAgentsMd(content: string): {
	valid: boolean;
	error?: string;
} {
	if (!content || content.trim().length === 0) {
		return { valid: false, error: "Content cannot be empty" };
	}

	// Check for at least one heading
	if (!content.match(/^#\s+.+/m)) {
		return {
			valid: false,
			error: "AGENTS.md must have at least one heading (# Title)",
		};
	}

	return { valid: true };
}

/**
 * Validate mcp.json content
 * Must be valid JSON with tools array
 */
export function validateMcpJson(content: string): {
	valid: boolean;
	error?: string;
} {
	try {
		const parsed = JSON.parse(content);

		if (!parsed.tools || !Array.isArray(parsed.tools)) {
			return {
				valid: false,
				error: "mcp.json must have a 'tools' array",
			};
		}

		for (const tool of parsed.tools) {
			if (!tool.name || typeof tool.name !== "string") {
				return {
					valid: false,
					error: "Each tool must have a 'name' string property",
				};
			}
		}

		return { valid: true };
	} catch (e) {
		return {
			valid: false,
			error: `Invalid JSON: ${e instanceof Error ? e.message : "Parse error"}`,
		};
	}
}

/**
 * Validate a skill file
 * Should be markdown with optional frontmatter
 */
export function validateSkillFile(content: string): {
	valid: boolean;
	error?: string;
} {
	if (!content || content.trim().length === 0) {
		return { valid: false, error: "Skill content cannot be empty" };
	}

	// Check for frontmatter (optional but recommended)
	const hasFrontmatter = content.startsWith("---");
	if (hasFrontmatter) {
		const endIndex = content.indexOf("---", 3);
		if (endIndex === -1) {
			return {
				valid: false,
				error: "Frontmatter must be closed with ---",
			};
		}
	}

	return { valid: true };
}

/**
 * Validate any memory file based on its type
 */
export function validateMemoryFile(
	path: string,
	content: string,
): { valid: boolean; error?: string } {
	const fileType = getFileTypeFromPath(path);

	switch (fileType) {
		case "AGENTS_MD":
			return validateAgentsMd(content);
		case "MCP_JSON":
			return validateMcpJson(content);
		case "SKILL":
			return validateSkillFile(content);
		case "KNOWLEDGE":
		case "CONVERSATION":
		case "CUSTOM":
			// Basic validation - just check not empty
			if (!content || content.trim().length === 0) {
				return { valid: false, error: "Content cannot be empty" };
			}
			return { valid: true };
		default:
			return { valid: true };
	}
}

// ============================================
// CONTEXT BUILDING (for execution)
// ============================================

/**
 * Load all memory for an agent instance into an execution context
 */
export async function loadAgentMemoryContext(ctx: MemoryFileContext): Promise<{
	agentsMd: string | null;
	mcpJson: Record<string, unknown> | null;
	skills: Array<{ path: string; content: string }>;
	knowledge: Array<{ path: string; content: string }>;
	recentConversations: Array<{ path: string; content: string }>;
}> {
	const [agentsFile, mcpFile, skillFiles, knowledgeFiles, conversationFiles] =
		await Promise.all([
			readMemoryFile(ctx, "AGENTS.md"),
			readMemoryFile(ctx, "mcp.json"),
			db.agentMemoryFile.findMany({
				where: {
					...buildTenantFilter(ctx),
					fileType: "SKILL",
					isEnabled: true,
				},
				orderBy: { path: "asc" },
			}),
			db.agentMemoryFile.findMany({
				where: { ...buildTenantFilter(ctx), fileType: "KNOWLEDGE" },
				orderBy: { path: "asc" },
			}),
			db.agentMemoryFile.findMany({
				where: { ...buildTenantFilter(ctx), fileType: "CONVERSATION" },
				orderBy: { updatedAt: "desc" },
				take: 5, // Last 5 conversations
			}),
		]);

	return {
		agentsMd: agentsFile?.content ?? null,
		mcpJson: mcpFile ? JSON.parse(mcpFile.content) : null,
		skills: skillFiles.map((f) => ({ path: f.path, content: f.content })),
		knowledge: knowledgeFiles.map((f) => ({
			path: f.path,
			content: f.content,
		})),
		recentConversations: conversationFiles.map((f) => ({
			path: f.path,
			content: f.content,
		})),
	};
}
