/**
 * Migration Script: Migrate Organization Data to Dedicated Collections
 *
 * This script migrates organization data from shared Qdrant collections
 * to dedicated org-specific collections for physical data isolation.
 *
 * Usage:
 *   npx tsx scripts/migrate-org-data.ts [--dry-run] [--org-id=<id>]
 *
 * Options:
 *   --dry-run    Preview changes without making them
 *   --org-id     Migrate only a specific organization (optional)
 *
 * What it does:
 * 1. Scans shared collections for data with organizationId set
 * 2. Creates org-specific collections if they don't exist
 * 3. Copies data to org-specific collections
 * 4. Deletes data from shared collections (after successful copy)
 */

import { logger } from "@repo/logs";
import {
	type BaseCollectionName,
	ensureCollection,
	getCollectionName,
	type MigrationResult,
} from "../lib/collection-manager";
import { qdrantClient } from "../lib/vector-store/client";

// Base collections to migrate
const BASE_COLLECTIONS: BaseCollectionName[] = [
	"chat-documents",
	"workspace-documents",
	"project-contexts",
	"fabric_orchestrator_memory",
	"fabric_capabilities",
];

// Batch size for scrolling
const BATCH_SIZE = 100;

interface MigrationOptions {
	dryRun: boolean;
	specificOrgId?: string;
}

/**
 * Get all unique organization IDs from a collection
 */
async function getOrganizationIds(collectionName: string): Promise<string[]> {
	const orgIds = new Set<string>();
	let offset: string | number | null | undefined;

	try {
		// Check if collection exists
		const collections = await qdrantClient.getCollections();
		const exists = collections.collections.some(
			(col) => col.name === collectionName,
		);
		if (!exists) {
			logger.info(
				`[Migration] Collection ${collectionName} doesn't exist, skipping`,
			);
			return [];
		}

		// Scroll through all points to find unique organizationIds
		while (true) {
			const result = await qdrantClient.scroll(collectionName, {
				limit: BATCH_SIZE,
				offset: offset ?? undefined,
				with_payload: true,
				with_vector: false,
				filter: {
					must_not: [{ is_null: { key: "organizationId" } }],
				},
			});

			for (const point of result.points) {
				const orgId = point.payload?.organizationId as
					| string
					| undefined;
				if (orgId) {
					orgIds.add(orgId);
				}
			}

			if (!result.next_page_offset) {
				break;
			}
			// Extract string/number from next_page_offset
			const nextOffset = result.next_page_offset;
			offset = typeof nextOffset === "object" ? null : nextOffset;
			if (offset === null) {
				break;
			}
		}
	} catch (error) {
		logger.error(
			`[Migration] Failed to get org IDs from ${collectionName}: ${error}`,
		);
	}

	return Array.from(orgIds);
}

/**
 * Migrate data for a specific organization from a shared collection
 */
async function migrateOrganizationData(
	baseCollection: BaseCollectionName,
	organizationId: string,
	options: MigrationOptions,
): Promise<MigrationResult> {
	const startTime = Date.now();
	const result: MigrationResult = {
		organizationId,
		baseCollection,
		pointsMigrated: 0,
		pointsDeleted: 0,
		errors: [],
		durationMs: 0,
		dryRun: options.dryRun,
	};

	const sourceCollection = baseCollection;
	const targetCollection = getCollectionName(baseCollection, organizationId);

	logger.info(
		`[Migration] Migrating ${baseCollection} for org ${organizationId}: ${sourceCollection} -> ${targetCollection}`,
	);

	try {
		// Ensure target collection exists
		if (!options.dryRun) {
			await ensureCollection(baseCollection, organizationId);
		}

		// Scroll through source collection and migrate
		let offset: string | number | null | undefined;
		const pointIdsToDelete: (string | number)[] = [];

		while (true) {
			const scrollResult = await qdrantClient.scroll(sourceCollection, {
				limit: BATCH_SIZE,
				offset: offset ?? undefined,
				with_payload: true,
				with_vector: true,
				filter: {
					must: [
						{
							key: "organizationId",
							match: { value: organizationId },
						},
					],
				},
			});

			if (scrollResult.points.length === 0) {
				break;
			}

			// Prepare points for upsert to target collection
			const pointsToMigrate = scrollResult.points.map((point) => ({
				id: point.id,
				vector: point.vector as number[],
				payload: point.payload,
			}));

			if (!options.dryRun && pointsToMigrate.length > 0) {
				// Upsert to target collection
				await qdrantClient.upsert(targetCollection, {
					wait: true,
					points: pointsToMigrate,
				});
			}

			result.pointsMigrated += pointsToMigrate.length;
			pointIdsToDelete.push(...scrollResult.points.map((p) => p.id));

			logger.info(
				`[Migration] ${options.dryRun ? "[DRY RUN] " : ""}Migrated ${result.pointsMigrated} points...`,
			);

			if (!scrollResult.next_page_offset) {
				break;
			}
			// Extract string/number from next_page_offset
			const nextOffset = scrollResult.next_page_offset;
			offset = typeof nextOffset === "object" ? null : nextOffset;
			if (offset === null) {
				break;
			}
		}

		// Delete from source collection
		if (!options.dryRun && pointIdsToDelete.length > 0) {
			// Delete in batches
			for (let i = 0; i < pointIdsToDelete.length; i += BATCH_SIZE) {
				const batch = pointIdsToDelete.slice(i, i + BATCH_SIZE);
				await qdrantClient.delete(sourceCollection, {
					wait: true,
					points: batch,
				});
				result.pointsDeleted += batch.length;
			}
		} else {
			result.pointsDeleted = pointIdsToDelete.length;
		}

		logger.info(
			`[Migration] ${options.dryRun ? "[DRY RUN] " : ""}Completed: ${result.pointsMigrated} migrated, ${result.pointsDeleted} deleted`,
		);
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		result.errors.push(errorMsg);
		logger.error(
			`[Migration] Error migrating ${baseCollection} for org ${organizationId}: ${errorMsg}`,
		);
	}

	result.durationMs = Date.now() - startTime;
	return result;
}

/**
 * Main migration function
 */
async function runMigration(options: MigrationOptions): Promise<void> {
	logger.info(
		`[Migration] Starting migration${options.dryRun ? " (DRY RUN)" : ""}`,
	);

	if (options.specificOrgId) {
		logger.info(
			`[Migration] Migrating only organization: ${options.specificOrgId}`,
		);
	}

	const allResults: MigrationResult[] = [];

	for (const baseCollection of BASE_COLLECTIONS) {
		logger.info(`[Migration] Processing collection: ${baseCollection}`);

		// Get organizations to migrate
		let orgIds: string[];
		if (options.specificOrgId) {
			orgIds = [options.specificOrgId];
		} else {
			orgIds = await getOrganizationIds(baseCollection);
		}

		if (orgIds.length === 0) {
			logger.info(
				`[Migration] No organization data found in ${baseCollection}`,
			);
			continue;
		}

		logger.info(
			`[Migration] Found ${orgIds.length} organizations in ${baseCollection}`,
		);

		// Migrate each organization
		for (const orgId of orgIds) {
			const result = await migrateOrganizationData(
				baseCollection,
				orgId,
				options,
			);
			allResults.push(result);
		}
	}

	// Summary
	logger.info("\n[Migration] ========== SUMMARY ==========");
	let totalMigrated = 0;
	let totalDeleted = 0;
	let totalErrors = 0;

	for (const result of allResults) {
		logger.info(
			`  ${result.baseCollection} (org: ${result.organizationId}): ${result.pointsMigrated} migrated, ${result.pointsDeleted} deleted, ${result.errors.length} errors, ${result.durationMs}ms`,
		);
		totalMigrated += result.pointsMigrated;
		totalDeleted += result.pointsDeleted;
		totalErrors += result.errors.length;
	}

	logger.info(
		`\n  TOTAL: ${totalMigrated} migrated, ${totalDeleted} deleted, ${totalErrors} errors`,
	);
	logger.info(
		`[Migration] ${options.dryRun ? "[DRY RUN] " : ""}Migration complete`,
	);
}

// Parse command line arguments
const args = process.argv.slice(2);
const options: MigrationOptions = {
	dryRun: args.includes("--dry-run"),
	specificOrgId: args.find((a) => a.startsWith("--org-id="))?.split("=")[1],
};

// Run migration
runMigration(options)
	.then(() => {
		process.exit(0);
	})
	.catch((error) => {
		logger.error(`[Migration] Fatal error: ${error}`);
		process.exit(1);
	});
