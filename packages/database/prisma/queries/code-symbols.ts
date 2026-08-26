/**
 * Code Symbol Queries
 *
 * CRUD operations for the CodeSymbol model which stores
 * extracted function/class/enum names for symbol-level code search.
 */

import { db } from "../client";

export interface CreateCodeSymbolInput {
	projectId: string;
	name: string;
	type: string;
	filePath: string;
	lineStart: number;
	lineEnd?: number | null;
	signature?: string | null;
	language: string;
	userId: string;
	organizationId?: string | null;
}

export interface SearchCodeSymbolsInput {
	projectId: string;
	query: string;
	type?: string | null;
	userId: string;
	organizationId?: string | null;
	limit?: number;
}

/**
 * Create multiple code symbols in a batch.
 */
export async function createCodeSymbols(
	symbols: CreateCodeSymbolInput[],
): Promise<{ count: number }> {
	if (symbols.length === 0) {
		return { count: 0 };
	}

	const result = await db.codeSymbol.createMany({
		data: symbols,
		skipDuplicates: false,
	});

	return { count: result.count };
}

/**
 * Delete all code symbols for a project.
 * Called before re-indexing to handle renames/deletions.
 */
export async function deleteCodeSymbolsByProject(
	projectId: string,
): Promise<void> {
	await db.codeSymbol.deleteMany({
		where: { projectId },
	});
}

/**
 * Delete a project's code symbols for a specific set of files. Used by the
 * per-batch extract+persist so re-running a batch (Temporal activity retry) is
 * idempotent — it clears that batch's rows before re-inserting, rather than
 * appending duplicates.
 */
export async function deleteCodeSymbolsByProjectAndFilePaths(
	projectId: string,
	filePaths: string[],
): Promise<void> {
	if (filePaths.length === 0) {
		return;
	}
	await db.codeSymbol.deleteMany({
		where: { projectId, filePath: { in: filePaths } },
	});
}

/**
 * Search code symbols by name (fuzzy match) with optional type filter.
 * Uses case-insensitive contains matching.
 *
 * Org context filters by organizationId only — symbols are written with the
 * user who ran indexing, but the project is shared, so any member with
 * PROJECT_READ (verified upstream) should see results indexed by anyone.
 */
export async function searchCodeSymbols(input: SearchCodeSymbolsInput) {
	const {
		projectId,
		query,
		type,
		userId,
		organizationId,
		limit = 20,
	} = input;

	const tenantFilter = organizationId
		? { organizationId }
		: { organizationId: null, userId };

	const symbols = await db.codeSymbol.findMany({
		where: {
			projectId,
			...tenantFilter,
			name: {
				contains: query,
				mode: "insensitive",
			},
			...(type ? { type } : {}),
		},
		take: limit,
		orderBy: {
			name: "asc",
		},
		select: {
			id: true,
			name: true,
			type: true,
			filePath: true,
			lineStart: true,
			lineEnd: true,
			signature: true,
			language: true,
		},
	});

	return symbols;
}

/**
 * Get code symbols for a specific file.
 */
export async function getCodeSymbolsByFile(
	projectId: string,
	filePath: string,
	userId: string,
	organizationId?: string | null,
) {
	const tenantFilter = organizationId
		? { organizationId }
		: { organizationId: null, userId };

	return db.codeSymbol.findMany({
		where: {
			projectId,
			filePath,
			...tenantFilter,
		},
		orderBy: {
			lineStart: "asc",
		},
		select: {
			id: true,
			name: true,
			type: true,
			filePath: true,
			lineStart: true,
			lineEnd: true,
			signature: true,
			language: true,
		},
	});
}

/**
 * Count code symbols for a project.
 */
export async function countCodeSymbols(
	projectId: string,
	userId: string,
	organizationId?: string | null,
): Promise<number> {
	const tenantFilter = organizationId
		? { organizationId }
		: { organizationId: null, userId };

	return db.codeSymbol.count({
		where: {
			projectId,
			...tenantFilter,
		},
	});
}
