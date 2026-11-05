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
import {
	assertSkillReadAccess,
	getSkillById,
	listTemplateSkills,
	skillVisibilityWhere,
} from "./skills";

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

/** Every memory read shares current catalog ACLs; copied source bytes remain pinned. */
export async function memorySourceBoundary(
	ctx: MemoryFileContext,
	where: Prisma.AgentMemoryFileWhereInput,
) {
	// Read provenance metadata first, never historical materialized content. Every
	// physical content read below is bounded by current source ACL and content hash.
	const provenance = await db.agentMemoryFile.findMany({
		where: { ...where, sourceSkillId: { not: null } },
		select: { sourceSkillId: true, contentHash: true },
	});
	const sourceIds = [
		...new Set(
			provenance
				.map((f) => f.sourceSkillId)
				.filter((id): id is string => typeof id === "string"),
		),
	];
	const readSources = async () => {
		if (!sourceIds.length) {
			return [];
		}
		await assertSkillReadAccess(ctx);
		const sources = await db.skill.findMany({
			where: {
				AND: [skillVisibilityWhere(ctx), { id: { in: sourceIds } }],
			},
			select: { id: true, content: true },
		});
		return sources.map((source) => ({
			sourceSkillId: source.id,
			contentHash: generateContentHash(source.content),
		}));
	};
	const sources = await readSources();
	const currentHashes = new Map(
		sources.map((s) => [s.sourceSkillId, s.contentHash]),
	);
	if (
		provenance.some(
			(file) =>
				file.sourceSkillId &&
				currentHashes.has(file.sourceSkillId) &&
				currentHashes.get(file.sourceSkillId) !== file.contentHash,
		)
	) {
		throw new Error(
			"A materialized skill source changed. Refresh this agent's skills before running again.",
		);
	}

	const sourceBoundary: Prisma.AgentMemoryFileWhereInput = {
		OR: [{ sourceSkillId: null }, ...sources],
	};
	const scopedWhere = {
		...where,
		AND: [
			...(Array.isArray(where.AND)
				? where.AND
				: where.AND
					? [where.AND]
					: []),
			sourceBoundary,
		],
	};
	return {
		where: scopedWhere,
		revalidate: async () => {
			const currentSources = await readSources();
			const fingerprint = (items: typeof sources) =>
				items
					.map((x) => `${x.sourceSkillId}:${x.contentHash}`)
					.sort()
					.join("|");
			if (fingerprint(currentSources) !== fingerprint(sources)) {
				throw new Error(
					"A materialized skill source changed. Refresh this agent's skills before running again.",
				);
			}
		},
	};
}

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

	const boundary = await memorySourceBoundary(ctx, where);
	const [files, total] = await Promise.all([
		db.agentMemoryFile.findMany({
			where: boundary.where,
			orderBy: { path: "asc" },
			skip: offset,
			take: limit,
		}),
		db.agentMemoryFile.count({ where: boundary.where }),
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

	await boundary.revalidate();
	return { files: filesWithMeta, total };
}

/**
 * Read a memory file by path
 */
export async function readMemoryFile(
	ctx: MemoryFileContext,
	path: string,
): Promise<AgentMemoryFile | null> {
	const boundary = await memorySourceBoundary(ctx, {
		...buildTenantFilter(ctx),
		path,
	});
	const file = await db.agentMemoryFile.findFirst({ where: boundary.where });
	await boundary.revalidate();
	return file;
}

/**
 * Check if a memory file exists
 */
export async function memoryFileExists(
	ctx: MemoryFileContext,
	path: string,
): Promise<boolean> {
	const boundary = await memorySourceBoundary(ctx, {
		...buildTenantFilter(ctx),
		path,
	});
	const count = await db.agentMemoryFile.count({ where: boundary.where });
	await boundary.revalidate();
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

	const sourceSkillId = options?.sourceSkillId;
	const existing = sourceSkillId
		? await (async () => {
				const source = await getSkillById(sourceSkillId, ctx);
				if (!source || source.content !== content) {
					throw new Error(
						"Refresh requires the current authorized skill instructions.",
					);
				}
				return db.agentMemoryFile.findFirst({
					where: { ...buildTenantFilter(ctx), path },
					select: { id: true },
				});
			})()
		: await readMemoryFile(ctx, path);
	if (
		!existing &&
		(await db.agentMemoryFile.count({
			where: { ...buildTenantFilter(ctx), path },
		}))
	) {
		throw new Error(
			"This linked skill is unavailable. Restore access or remove its attachment before writing.",
		);
	}

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
		const update = (client: Prisma.TransactionClient) =>
			client.agentMemoryFile.update({
				where: { ...buildTenantFilter(ctx), id: existing.id },
				data: updateData,
			});
		const updated = sourceSkillId
			? await db.$transaction(async (tx) => {
					const current = await getSkillById(sourceSkillId, ctx, tx);
					if (!current || current.content !== content) {
						throw new Error(
							"Current skill access changed before refresh.",
						);
					}
					// A refreshed parent must not grant access to an earlier confidential edit.
					await tx.agentMemoryEdit.deleteMany({
						where: {
							memoryFileId: existing.id,
							userId: ctx.userId,
							organizationId: ctx.organizationId ?? null,
						},
					});
					const refreshed = await update(tx);
					const after = await getSkillById(sourceSkillId, ctx, tx);
					if (!after || after.content !== content) {
						throw new Error(
							"Current skill access changed before refresh commit.",
						);
					}
					return refreshed;
				})
			: await update(db);
		if (sourceSkillId) {
			const source = await getSkillById(sourceSkillId, ctx);
			if (!source || source.content !== content) {
				throw new Error(
					"Skill access changed during refresh. Start a new refresh.",
				);
			}
		}
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
	if (sourceSkillId) {
		const source = await getSkillById(sourceSkillId, ctx);
		if (!source || source.content !== content) {
			throw new Error(
				"Skill access changed during materialization. Start a new refresh.",
			);
		}
	}
	return { file: created, created: true };
}

/**
 * Delete a memory file
 */
export async function deleteMemoryFile(
	ctx: MemoryFileContext,
	path: string,
): Promise<boolean> {
	// Removing an owned attachment reduces access and does not reveal its content.
	const file = await db.agentMemoryFile.findFirst({
		where: { ...buildTenantFilter(ctx), path },
		select: { id: true },
	});
	if (!file) {
		return false;
	}
	await db.agentMemoryFile.delete({
		where: { ...buildTenantFilter(ctx), id: file.id },
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

	const boundary = await memorySourceBoundary(ctx, where);
	const found = await db.agentMemoryFile.findMany({
		where: boundary.where,
		orderBy: { updatedAt: "desc" },
		take: limit,
	});
	await boundary.revalidate();
	return found;
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
	const boundary = await memorySourceBoundary(ctx, buildTenantFilter(ctx));
	const edits = await db.agentMemoryEdit.findMany({
		where: {
			agentInstanceId: ctx.agentInstanceId,
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? null,
			status: "PENDING",
			OR: [
				{ memoryFileId: null },
				{ memoryFile: { is: boundary.where } },
			],
		},
		orderBy: { createdAt: "desc" },
	});
	await boundary.revalidate();
	return edits;
}

/** Current actor and source access are required even for a direct edit ID. */
export async function getMemoryEdit(
	editId: string,
	actor?: { userId: string; organizationId?: string | null },
): Promise<AgentMemoryEdit | null> {
	if (!actor?.organizationId) {
		return null;
	}
	const metadata = await db.agentMemoryEdit.findFirst({
		where: { id: editId, ...actor },
		select: { agentInstanceId: true },
	});
	if (!metadata) {
		return null;
	}
	const boundary = await memorySourceBoundary(
		{ ...actor, agentInstanceId: metadata.agentInstanceId ?? undefined },
		buildTenantFilter({
			...actor,
			agentInstanceId: metadata.agentInstanceId ?? undefined,
		}),
	);
	const edit = await db.agentMemoryEdit.findFirst({
		where: {
			id: editId,
			...actor,
			OR: [
				{ memoryFileId: null },
				{ memoryFile: { is: boundary.where } },
			],
		},
	});
	await boundary.revalidate();
	return edit;
}

/**
 * Approve and apply a memory edit
 */
async function requireCurrentEdit(editId: string, userId: string) {
	const metadata = await db.agentMemoryEdit.findFirst({
		where: { id: editId, userId },
		select: { organizationId: true },
	});
	const edit = metadata
		? await getMemoryEdit(editId, {
				userId,
				organizationId: metadata.organizationId,
			})
		: null;
	if (!edit) {
		throw new Error(
			"Memory edit not found or its source access is unavailable.",
		);
	}
	return edit;
}
export async function approveMemoryEdit(
	editId: string,
	approvedBy: string,
): Promise<{ edit: AgentMemoryEdit; file: AgentMemoryFile | null }> {
	const authorized = await requireCurrentEdit(editId, approvedBy);
	const edit = await db.agentMemoryEdit.update({
		where: {
			id: editId,
			userId: approvedBy,
			organizationId: authorized.organizationId,
		},
		data: {
			status: "APPROVED",
			approvedBy,
			approvedAt: new Date(),
		},
	});

	const file = await applyMemoryEdit(editId, approvedBy);

	await requireCurrentEdit(editId, approvedBy);
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
	const authorized = await requireCurrentEdit(editId, rejectedBy);
	const edit = await db.agentMemoryEdit.update({
		where: {
			id: editId,
			userId: rejectedBy,
			organizationId: authorized.organizationId,
		},
		data: {
			status: "REJECTED",
			approvedBy: rejectedBy, // Reuse field for who rejected
			approvedAt: new Date(),
			rejectionReason: reason,
		},
	});
	await requireCurrentEdit(editId, rejectedBy);
	return edit;
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
	const templateSkills = await listTemplateSkills(templateId, {
		userId,
		organizationId,
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

/** The exact enabled memory revisions captured by native test admission. */
export interface FrozenAgentMemoryFile {
	id: string;
	version: number;
	contentHash: string;
	sourceSkillId?: string | null;
}

/**
 * Load execution memory. A supplied manifest constrains all five physical
 * content queries to the admitted revisions; no newly enabled or edited file
 * can enter the prompt between admission and the actual read.
 */
export async function loadAgentMemoryContext(
	ctx: MemoryFileContext,
	frozenMemoryFiles?: ReadonlyArray<FrozenAgentMemoryFile>,
): Promise<{
	agentsMd: string | null;
	mcpJson: Record<string, unknown> | null;
	skills: Array<{ path: string; content: string }>;
	knowledge: Array<{ path: string; content: string }>;
	recentConversations: Array<{ path: string; content: string }>;
}> {
	if (
		frozenMemoryFiles !== undefined &&
		(!Array.isArray(frozenMemoryFiles) ||
			frozenMemoryFiles.some(
				(file) =>
					!file ||
					typeof file.id !== "string" ||
					!file.id ||
					!Number.isSafeInteger(file.version) ||
					file.version < 1 ||
					typeof file.contentHash !== "string" ||
					!/^[a-f0-9]{64}$/.test(file.contentHash) ||
					(file.sourceSkillId !== undefined &&
						file.sourceSkillId !== null &&
						typeof file.sourceSkillId !== "string"),
			))
	) {
		throw new Error("Invalid frozen agent memory manifest");
	}
	if (frozenMemoryFiles?.length === 0) {
		return {
			agentsMd: null,
			mcpJson: null,
			skills: [],
			knowledge: [],
			recentConversations: [],
		};
	}
	const where: Prisma.AgentMemoryFileWhereInput = {
		...buildTenantFilter(ctx),
		...(frozenMemoryFiles === undefined
			? {}
			: {
					isEnabled: true,
					OR: frozenMemoryFiles.map((file) => ({
						id: file.id,
						version: file.version,
						contentHash: file.contentHash,
						...(file.sourceSkillId === undefined
							? {}
							: { sourceSkillId: file.sourceSkillId }),
					})),
				}),
	};
	const source = await memorySourceBoundary(ctx, where);
	const scopedWhere = source.where;
	const contextFile = (path: string) =>
		db.agentMemoryFile.findFirst({ where: { ...scopedWhere, path } });
	const [agentsFile, mcpFile, skillFiles, knowledgeFiles, conversationFiles] =
		await Promise.all([
			contextFile("AGENTS.md"),
			contextFile("mcp.json"),
			db.agentMemoryFile.findMany({
				where: {
					...scopedWhere,
					fileType: "SKILL",
					isEnabled: true,
				},
				orderBy: { path: "asc" },
			}),
			db.agentMemoryFile.findMany({
				where: { ...scopedWhere, fileType: "KNOWLEDGE" },
				orderBy: { path: "asc" },
			}),
			db.agentMemoryFile.findMany({
				where: { ...scopedWhere, fileType: "CONVERSATION" },
				orderBy: { updatedAt: "desc" },
				take: 5, // Last 5 conversations
			}),
		]);

	await source.revalidate();
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
