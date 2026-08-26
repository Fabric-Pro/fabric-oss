/**
 * Database queries for WizardTempContext model
 * Handles temporary file storage during project wizard before project creation
 */

import {
	db,
	type ExtractionStatus,
	type Prisma,
	type ProjectContextType,
} from "../client";

/**
 * Create a new wizard temp context
 */
export async function createWizardTempContext(data: {
	sessionId: string;
	userId: string;
	organizationId?: string;
	type: ProjectContextType;
	s3Path: string;
	s3Bucket: string;
	originalFilename: string;
	mimeType: string;
	fileSize: number;
	content?: string;
	metadata?: Prisma.InputJsonValue;
}) {
	// Set expiration to 24 hours from now
	const expiresAt = new Date();
	expiresAt.setHours(expiresAt.getHours() + 24);

	return await db.wizardTempContext.create({
		data: {
			sessionId: data.sessionId,
			userId: data.userId,
			organizationId: data.organizationId,
			type: data.type,
			s3Path: data.s3Path,
			s3Bucket: data.s3Bucket,
			originalFilename: data.originalFilename,
			mimeType: data.mimeType,
			fileSize: data.fileSize,
			content: data.content || "",
			metadata: data.metadata,
			expiresAt,
		},
	});
}

/**
 * Get wizard temp context by ID
 */
export async function getWizardTempContextById(
	id: string,
	userId: string,
	organizationId?: string,
) {
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.wizardTempContext.findFirst({
		where: {
			id,
			userId,
			...orgFilter,
		},
	});
}

/**
 * List wizard temp contexts for a session
 */
export async function listWizardTempContextsBySession(
	sessionId: string,
	userId: string,
	organizationId?: string,
) {
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.wizardTempContext.findMany({
		where: {
			sessionId,
			userId,
			...orgFilter,
		},
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Update wizard temp context extraction status and content
 */
export async function updateWizardTempContextExtraction(
	id: string,
	data: {
		extractionStatus: ExtractionStatus;
		content?: string;
		extractionError?: string;
		extractedAt?: Date;
	},
) {
	return await db.wizardTempContext.update({
		where: { id },
		data,
	});
}

/**
 * Update wizard temp context with Qdrant embedding info
 */
export async function updateWizardTempContextEmbedding(
	id: string,
	data: {
		qdrantId: string;
		embeddedAt: Date;
	},
) {
	return await db.wizardTempContext.update({
		where: { id },
		data,
	});
}

/**
 * Update the documentTag in a wizard temp context's metadata
 */
export async function updateWizardTempContextTag(
	id: string,
	userId: string,
	documentTag: string | null,
	organizationId?: string,
) {
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const context = await db.wizardTempContext.findFirst({
		where: { id, userId, ...orgFilter },
	});

	if (!context) {
		throw new Error("Temp context not found");
	}

	const currentMetadata = (context.metadata as Record<string, unknown>) ?? {};
	const updatedMetadata = { ...currentMetadata };

	if (documentTag) {
		updatedMetadata.documentTag = documentTag;
		updatedMetadata.documentTitle =
			(currentMetadata.title as string)?.replace(/\.[^/.]+$/, "") ||
			context.originalFilename?.replace(/\.[^/.]+$/, "") ||
			"Untitled";
	} else {
		delete updatedMetadata.documentTag;
		delete updatedMetadata.documentTitle;
	}

	return await db.wizardTempContext.update({
		where: { id },
		data: { metadata: updatedMetadata as Prisma.InputJsonValue },
	});
}

/**
 * Delete wizard temp context by ID
 */
export async function deleteWizardTempContext(
	id: string,
	userId: string,
	organizationId?: string,
) {
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.wizardTempContext.delete({
		where: {
			id,
			userId,
			...orgFilter,
		},
	});
}

/**
 * Delete all wizard temp contexts for a session
 */
export async function deleteWizardTempContextsBySession(
	sessionId: string,
	userId: string,
	organizationId?: string,
) {
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.wizardTempContext.deleteMany({
		where: {
			sessionId,
			userId,
			...orgFilter,
		},
	});
}

/**
 * Move wizard temp contexts to project contexts
 * Called after project creation to migrate temp files to the project
 *
 * Returns a mapping from WizardTempContext.id to ProjectContext.id
 * so that Qdrant embeddings can be updated with the new project binding.
 */
export async function moveWizardTempContextsToProject(
	sessionId: string,
	projectId: string,
	userId: string,
	organizationId?: string,
): Promise<{
	movedCount: number;
	contextIds: string[];
	/** Map of WizardTempContext.id -> ProjectContext.id for Qdrant payload updates */
	contextIdMapping: Record<string, string>;
	/** Session ID for Qdrant query */
	sessionId: string;
}> {
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	// Get all temp contexts for the session
	const tempContexts = await db.wizardTempContext.findMany({
		where: {
			sessionId,
			userId,
			...orgFilter,
		},
	});

	if (tempContexts.length === 0) {
		return {
			movedCount: 0,
			contextIds: [],
			contextIdMapping: {},
			sessionId,
		};
	}

	// Create project contexts from temp contexts
	const createdContexts = await db.$transaction(
		tempContexts.map((temp) =>
			db.projectContext.create({
				data: {
					projectId,
					type: temp.type,
					content: temp.content,
					// Note: qdrantId will be updated by the binding activity
					// We don't copy it here because the Qdrant point payload will change
					qdrantId: null,
					embeddedAt: temp.embeddedAt,
					metadata: temp.metadata ?? undefined,
					s3Path: temp.s3Path,
					s3Bucket: temp.s3Bucket,
					originalFilename: temp.originalFilename,
					mimeType: temp.mimeType,
					fileSize: temp.fileSize,
					extractionStatus: temp.extractionStatus,
					extractionError: temp.extractionError,
					extractedAt: temp.extractedAt,
				},
			}),
		),
	);

	// Build mapping from old WizardTempContext.id to new ProjectContext.id
	const contextIdMapping: Record<string, string> = {};
	for (let i = 0; i < tempContexts.length; i++) {
		const tempContext = tempContexts[i];
		const projectContext = createdContexts[i];
		if (tempContext && projectContext) {
			contextIdMapping[tempContext.id] = projectContext.id;
		}
	}

	// Delete temp contexts after successful migration
	await db.wizardTempContext.deleteMany({
		where: {
			sessionId,
			userId,
			...orgFilter,
		},
	});

	return {
		movedCount: createdContexts.length,
		contextIds: createdContexts.map((c) => c.id),
		contextIdMapping,
		sessionId,
	};
}

/**
 * Get expired wizard temp contexts for cleanup
 */
export async function getExpiredWizardTempContexts(limit = 100) {
	return await db.wizardTempContext.findMany({
		where: {
			expiresAt: {
				lt: new Date(),
			},
		},
		take: limit,
	});
}

/**
 * Delete expired wizard temp contexts
 * Used by cleanup workflow
 */
export async function deleteExpiredWizardTempContexts() {
	const result = await db.wizardTempContext.deleteMany({
		where: {
			expiresAt: {
				lt: new Date(),
			},
		},
	});

	return { deletedCount: result.count };
}

/**
 * Get wizard temp contexts that need embedding
 */
export async function getUnembeddedWizardTempContexts(
	sessionId: string,
	userId: string,
	organizationId?: string,
) {
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.wizardTempContext.findMany({
		where: {
			sessionId,
			userId,
			...orgFilter,
			extractionStatus: "COMPLETED",
			embeddedAt: null,
		},
	});
}
