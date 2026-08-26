/**
 * Seed script for AI Model Catalog
 *
 * This script populates the database with:
 * 1. AI Models - canonical model definitions
 * 2. Provider Mappings - provider-specific model IDs
 * 3. Task Defaults - default models for each task type
 *
 * Run with: pnpm --filter @repo/database seed:ai-models
 *
 * To validate model names before seeding:
 *   pnpm --filter @repo/database test:ai-models
 */

import { logger } from "@repo/logs";
import { MODELS, TASK_DEFAULTS } from "./ai-model-catalog";
import { db } from "./client";

// Re-export for backwards compatibility
export { MODELS, TASK_DEFAULTS };

// ============================================================================
// Seed Functions
// ============================================================================

async function seedModels() {
	logger.info("Seeding AI models...");

	let createdCount = 0;
	let updatedCount = 0;

	for (const modelData of MODELS) {
		try {
			const existing = await db.aiModel.findUnique({
				where: { canonicalName: modelData.canonicalName },
			});

			const model = await db.aiModel.upsert({
				where: { canonicalName: modelData.canonicalName },
				create: {
					canonicalName: modelData.canonicalName,
					displayName: modelData.displayName,
					description: modelData.description,
					family: modelData.family,
					vendor: modelData.vendor,
					capabilities: modelData.capabilities,
					contextWindow: modelData.contextWindow,
					maxOutputTokens: modelData.maxOutputTokens,
					speedTier: modelData.speedTier,
					qualityTier: modelData.qualityTier,
					inputCostPer1M: modelData.inputCostPer1M,
					outputCostPer1M: modelData.outputCostPer1M,
					suitableForTasks: modelData.suitableForTasks,
				},
				update: {
					displayName: modelData.displayName,
					description: modelData.description,
					family: modelData.family,
					vendor: modelData.vendor,
					capabilities: modelData.capabilities,
					contextWindow: modelData.contextWindow,
					maxOutputTokens: modelData.maxOutputTokens,
					speedTier: modelData.speedTier,
					qualityTier: modelData.qualityTier,
					inputCostPer1M: modelData.inputCostPer1M,
					outputCostPer1M: modelData.outputCostPer1M,
					suitableForTasks: modelData.suitableForTasks,
				},
			});

			if (existing) {
				updatedCount++;
			} else {
				createdCount++;
			}

			// Seed provider mappings
			for (const mapping of modelData.providerMappings) {
				await db.aiModelProviderMapping.upsert({
					where: {
						modelId_provider: {
							modelId: model.id,
							provider: mapping.provider,
						},
					},
					create: {
						modelId: model.id,
						provider: mapping.provider,
						providerModelId: mapping.providerModelId,
						inputCostPer1M: mapping.inputCostPer1M,
						outputCostPer1M: mapping.outputCostPer1M,
						isAvailable: true,
					},
					update: {
						providerModelId: mapping.providerModelId,
						inputCostPer1M: mapping.inputCostPer1M,
						outputCostPer1M: mapping.outputCostPer1M,
						isAvailable: true,
					},
				});
			}

			logger.info(
				`  ✓ ${modelData.displayName} (${modelData.canonicalName})`,
			);
		} catch (error) {
			logger.error(
				`  ✗ Error seeding ${modelData.canonicalName}:`,
				error,
			);
		}
	}

	logger.info(`\nModels: ${createdCount} created, ${updatedCount} updated`);
}

async function seedTaskDefaults() {
	logger.info("\nSeeding provider-specific task defaults...");

	let createdCount = 0;
	let updatedCount = 0;
	let skippedCount = 0;

	for (const defaultData of TASK_DEFAULTS) {
		try {
			// Find the model by canonical name
			const model = await db.aiModel.findUnique({
				where: { canonicalName: defaultData.canonicalName },
			});

			if (!model) {
				logger.warn(
					`  ⚠ Model not found: ${defaultData.canonicalName} for ${defaultData.provider}, skipping`,
				);
				skippedCount++;
				continue;
			}

			const existing = await db.aiTaskModelDefault.findFirst({
				where: {
					taskType: defaultData.taskType,
					complexity: defaultData.complexity,
					provider: defaultData.provider,
				},
			});

			// Use the new unique constraint: taskType + complexity + provider
			await db.aiTaskModelDefault.upsert({
				where: {
					taskType_complexity_provider: {
						taskType: defaultData.taskType,
						complexity: defaultData.complexity,
						provider: defaultData.provider,
					},
				},
				create: {
					taskType: defaultData.taskType,
					complexity: defaultData.complexity,
					modelId: model.id,
					provider: defaultData.provider,
					priority: defaultData.priority,
					requiresToolCalling:
						defaultData.requiresToolCalling ?? false,
				},
				update: {
					modelId: model.id,
					priority: defaultData.priority,
					requiresToolCalling:
						defaultData.requiresToolCalling ?? false,
				},
			});

			if (existing) {
				updatedCount++;
			} else {
				createdCount++;
			}

			logger.info(
				`  ✓ ${defaultData.taskType}/${defaultData.provider} -> ${defaultData.canonicalName}`,
			);
		} catch (error) {
			logger.error(
				`  ✗ Error seeding default for ${defaultData.taskType}/${defaultData.provider}:`,
				error,
			);
		}
	}

	logger.info(
		`Task defaults: ${createdCount} created, ${updatedCount} updated, ${skippedCount} skipped`,
	);
}

async function cleanupOrphanedData() {
	logger.info("Cleaning up orphaned provider mappings and task defaults...");

	// Get all canonical names from the catalog
	const catalogNames = new Set(MODELS.map((m) => m.canonicalName));

	// Find models in DB that are NOT in the catalog (orphaned/deprecated)
	const allDbModels = await db.aiModel.findMany({
		select: { id: true, canonicalName: true },
	});

	const orphanedModelIds = allDbModels
		.filter((m) => !catalogNames.has(m.canonicalName))
		.map((m) => m.id);

	if (orphanedModelIds.length > 0) {
		// Delete task defaults for orphaned models
		const deletedDefaults = await db.aiTaskModelDefault.deleteMany({
			where: { modelId: { in: orphanedModelIds } },
		});
		logger.info(
			`  Deleted ${deletedDefaults.count} orphaned task defaults`,
		);

		// Delete provider mappings for orphaned models
		const deletedMappings = await db.aiModelProviderMapping.deleteMany({
			where: { modelId: { in: orphanedModelIds } },
		});
		logger.info(
			`  Deleted ${deletedMappings.count} orphaned provider mappings`,
		);

		// Delete orphaned models (this will cascade to any user preferences referencing them)
		const deletedModels = await db.aiModel.deleteMany({
			where: { id: { in: orphanedModelIds } },
		});
		logger.info(`  Deleted ${deletedModels.count} orphaned models`);
	} else {
		logger.info("  No orphaned models found");
	}

	// Per-model orphan mapping cleanup (PR 1090 review I-1).
	//
	// The block above only deletes mappings whose entire MODEL was removed
	// from the catalog. It does NOT catch the case where a single
	// (modelId, provider) pair was deleted from a model whose other
	// mappings still exist - e.g., Fallback A removed
	// (o3-mini, VERCEL_GATEWAY) while keeping (o3-mini, OPENAI_DIRECT) and
	// (o3-mini, OPENROUTER). Without this pass, picker queries filtered by
	// isAvailable: true would still return the removed mapping, and orgs
	// with a stored OrganizationModelPreference pointing at the removed
	// pair would later throw at model resolution.
	//
	// We build a Set of (canonicalName, provider) strings from the catalog
	// and delete any mapping whose pair is not in the set. Catalog is the
	// source of truth; DB drift is reconciled here.
	const catalogPairs = new Set<string>();
	for (const model of MODELS) {
		for (const mapping of model.providerMappings) {
			catalogPairs.add(`${model.canonicalName} ${mapping.provider}`);
		}
	}
	const allDbMappings = await db.aiModelProviderMapping.findMany({
		select: {
			id: true,
			provider: true,
			model: { select: { canonicalName: true } },
		},
	});
	const orphanedMappingIds = allDbMappings
		.filter(
			(m) => !catalogPairs.has(`${m.model.canonicalName} ${m.provider}`),
		)
		.map((m) => m.id);
	if (orphanedMappingIds.length > 0) {
		const deletedPerModelMappings =
			await db.aiModelProviderMapping.deleteMany({
				where: { id: { in: orphanedMappingIds } },
			});
		logger.info(
			`  Deleted ${deletedPerModelMappings.count} orphaned provider mappings (per-model - catalog removed the pair, model still exists)`,
		);
	} else {
		logger.info("  No orphaned per-model mappings found");
	}

	// Clean up task defaults that reference providers not in the catalog
	const catalogProviders = new Set(
		TASK_DEFAULTS.map((d) => `${d.taskType}-${d.complexity}-${d.provider}`),
	);

	const allDefaults = await db.aiTaskModelDefault.findMany({
		select: { id: true, taskType: true, complexity: true, provider: true },
	});

	const orphanedDefaultIds = allDefaults
		.filter(
			(d) =>
				!catalogProviders.has(
					`${d.taskType}-${d.complexity}-${d.provider}`,
				),
		)
		.map((d) => d.id);

	if (orphanedDefaultIds.length > 0) {
		const deletedOrphanedDefaults = await db.aiTaskModelDefault.deleteMany({
			where: { id: { in: orphanedDefaultIds } },
		});
		logger.info(
			`  Deleted ${deletedOrphanedDefaults.count} orphaned task defaults (provider removed from catalog)`,
		);
	}

	logger.info("Cleanup complete.");
}

export async function seedAiModels() {
	logger.info("=".repeat(60));
	logger.info("AI Model Catalog Seed");
	logger.info("=".repeat(60));

	// Check if user preferences exist - if so, inform about preservation
	const userPrefsCount = await db.userModelPreference.count();
	const orgPrefsCount = await db.organizationModelPreference.count();

	if (userPrefsCount > 0 || orgPrefsCount > 0) {
		logger.info(
			`Found ${userPrefsCount} user and ${orgPrefsCount} org model preferences - using upsert mode to preserve them`,
		);
	}

	// Clean up orphaned data (models not in catalog) without affecting valid models
	await cleanupOrphanedData();

	await seedModels();
	await seedTaskDefaults();

	logger.info(`\n${"=".repeat(60)}`);
	logger.info("AI Model Catalog seed completed!");
	logger.info("=".repeat(60));
}

// Run if called directly
if (require.main === module) {
	seedAiModels()
		.then(() => process.exit(0))
		.catch((error) => {
			logger.error("Seed failed:", error);
			process.exit(1);
		});
}
