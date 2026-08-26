/**
 * Database queries for Workspace RAG Settings
 *
 * Handles configuration for document chunking, embedding, and retrieval.
 */

import { type ChunkSplitMethod, db, type EmbeddingModel } from "../../client";
import { canManageWorkspace } from "./workspaces";

// ============================================================================
// Types
// ============================================================================

export interface UpdateRagSettingsInput {
	chunkSize?: number;
	chunkOverlap?: number;
	splitMethod?: ChunkSplitMethod;
	embeddingModel?: EmbeddingModel;
	topK?: number;
	similarityThreshold?: number;
	enableReranking?: boolean;
}

// ============================================================================
// Read
// ============================================================================

/**
 * Get RAG settings for a workspace
 */
export async function getWorkspaceRagSettings(workspaceId: string) {
	return await db.workspaceRagSettings.findUnique({
		where: { workspaceId },
	});
}

/**
 * Get RAG settings or create defaults if not exists
 */
export async function getOrCreateRagSettings(workspaceId: string) {
	const existing = await db.workspaceRagSettings.findUnique({
		where: { workspaceId },
	});

	if (existing) {
		return existing;
	}

	// Create default settings
	return await db.workspaceRagSettings.create({
		data: {
			workspaceId,
		},
	});
}

// ============================================================================
// Update
// ============================================================================

/**
 * Update RAG settings for a workspace
 * Only administrators can update settings
 */
export async function updateWorkspaceRagSettings(
	workspaceId: string,
	userId: string,
	data: UpdateRagSettingsInput,
) {
	// Verify user can manage workspace
	const canManage = await canManageWorkspace(workspaceId, userId);
	if (!canManage) {
		throw new Error("Only administrators can update RAG settings");
	}

	// Validate settings
	if (data.chunkSize !== undefined) {
		if (data.chunkSize < 100 || data.chunkSize > 10000) {
			throw new Error(
				"Chunk size must be between 100 and 10000 characters",
			);
		}
	}

	if (data.chunkOverlap !== undefined) {
		if (data.chunkOverlap < 0 || data.chunkOverlap > 2000) {
			throw new Error(
				"Chunk overlap must be between 0 and 2000 characters",
			);
		}
	}

	if (data.topK !== undefined) {
		if (data.topK < 1 || data.topK > 50) {
			throw new Error("Top K must be between 1 and 50");
		}
	}

	if (data.similarityThreshold !== undefined) {
		if (data.similarityThreshold < 0 || data.similarityThreshold > 1) {
			throw new Error("Similarity threshold must be between 0 and 1");
		}
	}

	return await db.workspaceRagSettings.upsert({
		where: { workspaceId },
		create: {
			workspaceId,
			...data,
		},
		update: data,
	});
}

/**
 * Reset RAG settings to defaults
 */
export async function resetWorkspaceRagSettings(
	workspaceId: string,
	userId: string,
) {
	// Verify user can manage workspace
	const canManage = await canManageWorkspace(workspaceId, userId);
	if (!canManage) {
		throw new Error("Only administrators can reset RAG settings");
	}

	return await db.workspaceRagSettings.upsert({
		where: { workspaceId },
		create: {
			workspaceId,
		},
		update: {
			chunkSize: 3000,
			chunkOverlap: 500,
			splitMethod: "DOCUMENT",
			embeddingModel: "TEXT_EMBEDDING_3_SMALL",
			topK: 5,
			similarityThreshold: 0.5,
			enableReranking: false,
		},
	});
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get default RAG settings (system defaults)
 */
export function getDefaultRagSettings() {
	return {
		chunkSize: 3000,
		chunkOverlap: 500,
		splitMethod: "DOCUMENT" as ChunkSplitMethod,
		embeddingModel: "TEXT_EMBEDDING_3_SMALL" as EmbeddingModel,
		topK: 5,
		similarityThreshold: 0.5,
		enableReranking: false,
	};
}

/**
 * Get effective RAG settings with inheritance:
 * Workspace settings > Organization settings > System defaults
 */
export async function getEffectiveRagSettings(workspaceId: string) {
	// Get workspace with organization info
	const workspace = await db.workspace.findUnique({
		where: { id: workspaceId },
		select: { organizationId: true },
	});

	// Get workspace-specific settings
	const workspaceSettings = await db.workspaceRagSettings.findUnique({
		where: { workspaceId },
	});

	// Get organization settings if workspace belongs to an organization
	const orgSettings = workspace?.organizationId
		? await db.organizationRagSettings.findUnique({
				where: { organizationId: workspace.organizationId },
			})
		: null;

	// Start with system defaults
	const defaults = getDefaultRagSettings();

	// Merge with organization settings (if any)
	const withOrgDefaults = {
		chunkSize: orgSettings?.chunkSize ?? defaults.chunkSize,
		chunkOverlap: orgSettings?.chunkOverlap ?? defaults.chunkOverlap,
		splitMethod: orgSettings?.splitMethod ?? defaults.splitMethod,
		embeddingModel: orgSettings?.embeddingModel ?? defaults.embeddingModel,
		topK: orgSettings?.topK ?? defaults.topK,
		similarityThreshold:
			orgSettings?.similarityThreshold ?? defaults.similarityThreshold,
		enableReranking:
			orgSettings?.enableReranking ?? defaults.enableReranking,
	};

	// Merge with workspace settings (if any)
	// Note: Workspace settings in DB have non-nullable defaults, so we check if record exists
	if (!workspaceSettings) {
		return withOrgDefaults;
	}

	return {
		chunkSize: workspaceSettings.chunkSize,
		chunkOverlap: workspaceSettings.chunkOverlap,
		splitMethod: workspaceSettings.splitMethod,
		embeddingModel: workspaceSettings.embeddingModel,
		topK: workspaceSettings.topK,
		similarityThreshold: workspaceSettings.similarityThreshold,
		enableReranking: workspaceSettings.enableReranking,
	};
}

/**
 * Get embedding model dimensions
 */
export function getEmbeddingModelDimensions(model: EmbeddingModel): number {
	switch (model) {
		case "TEXT_EMBEDDING_3_SMALL":
			return 1536;
		case "TEXT_EMBEDDING_3_LARGE":
			return 3072;
		default:
			return 1536;
	}
}
