/**
 * Database queries for Organization RAG Settings
 *
 * Handles organization-level default settings for document chunking, embedding, and retrieval.
 * These settings serve as defaults for all workspaces in the organization.
 */

import { type ChunkSplitMethod, db, type EmbeddingModel } from "../../client";
import { getOrganizationMembership } from "../organizations";

// ============================================================================
// Types
// ============================================================================

export interface UpdateOrgRagSettingsInput {
	chunkSize?: number | null;
	chunkOverlap?: number | null;
	splitMethod?: ChunkSplitMethod | null;
	embeddingModel?: EmbeddingModel | null;
	topK?: number | null;
	similarityThreshold?: number | null;
	enableReranking?: boolean | null;
}

// ============================================================================
// Read
// ============================================================================

/**
 * Get RAG settings for an organization
 */
export async function getOrganizationRagSettings(organizationId: string) {
	return await db.organizationRagSettings.findUnique({
		where: { organizationId },
	});
}

/**
 * Get RAG settings or create defaults if not exists
 */
export async function getOrCreateOrganizationRagSettings(
	organizationId: string,
) {
	const existing = await db.organizationRagSettings.findUnique({
		where: { organizationId },
	});

	if (existing) {
		return existing;
	}

	// Create default settings (all null - meaning use system defaults)
	return await db.organizationRagSettings.create({
		data: {
			organizationId,
		},
	});
}

// ============================================================================
// Update
// ============================================================================

/**
 * Update RAG settings for an organization
 * Only admins/owners can update settings
 */
export async function updateOrganizationRagSettings(
	organizationId: string,
	userId: string,
	data: UpdateOrgRagSettingsInput,
) {
	// Verify user is admin/owner
	const membership = await getOrganizationMembership(organizationId, userId);
	if (!membership || !["owner", "admin"].includes(membership.role)) {
		throw new Error("Only organization admins can update RAG settings");
	}

	// Validate settings
	if (data.chunkSize !== undefined && data.chunkSize !== null) {
		if (data.chunkSize < 100 || data.chunkSize > 10000) {
			throw new Error(
				"Chunk size must be between 100 and 10000 characters",
			);
		}
	}

	if (data.chunkOverlap !== undefined && data.chunkOverlap !== null) {
		if (data.chunkOverlap < 0 || data.chunkOverlap > 2000) {
			throw new Error(
				"Chunk overlap must be between 0 and 2000 characters",
			);
		}
	}

	if (data.topK !== undefined && data.topK !== null) {
		if (data.topK < 1 || data.topK > 50) {
			throw new Error("Top K must be between 1 and 50");
		}
	}

	if (
		data.similarityThreshold !== undefined &&
		data.similarityThreshold !== null
	) {
		if (data.similarityThreshold < 0 || data.similarityThreshold > 1) {
			throw new Error("Similarity threshold must be between 0 and 1");
		}
	}

	return await db.organizationRagSettings.upsert({
		where: { organizationId },
		create: {
			organizationId,
			...data,
		},
		update: data,
	});
}

/**
 * Reset RAG settings to defaults (clear all overrides)
 */
export async function resetOrganizationRagSettings(
	organizationId: string,
	userId: string,
) {
	// Verify user is admin/owner
	const membership = await getOrganizationMembership(organizationId, userId);
	if (!membership || !["owner", "admin"].includes(membership.role)) {
		throw new Error("Only organization admins can reset RAG settings");
	}

	return await db.organizationRagSettings.upsert({
		where: { organizationId },
		create: {
			organizationId,
		},
		update: {
			chunkSize: null,
			chunkOverlap: null,
			splitMethod: null,
			embeddingModel: null,
			topK: null,
			similarityThreshold: null,
			enableReranking: null,
		},
	});
}
