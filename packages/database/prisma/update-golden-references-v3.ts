/**
 * Update existing golden references to EVAL_VERSION 3 standards
 *
 * This script updates existing SYSTEM-scoped golden references with:
 * - New requiredSections (e.g., PRD now includes "risks")
 * - Enhanced keyPhrases (e.g., PRD includes "SMART goals", "problem statement")
 *
 * Run with: pnpm update:golden-references-v3
 */

import type { ProjectDocumentType } from "./client";
import { db } from "./client";

interface GoldenReferenceUpdate {
	documentType: ProjectDocumentType;
	name: string;
	requiredSections: string[];
	keyPhrases: string[];
	description?: string;
}

// EVAL_VERSION 3 updates
const V3_UPDATES: GoldenReferenceUpdate[] = [
	{
		documentType: "PRD",
		name: "PRD - SaaS Product Template",
		description:
			"Golden reference for Product Requirements Documents aligned with industry standards (EVAL_VERSION 3).",
		requiredSections: [
			"metadata",
			"vision",
			"stakeholders",
			"summary",
			"goals",
			"users",
			"requirements",
			"risks",
			"timeline",
		],
		keyPhrases: [
			// Core PRD phrases
			"success metrics",
			"acceptance criteria",
			"user persona",
			"user story",
			"priority",
			"P0",
			"P1",
			"P2",
			"MVP",
			"KPI",
			"target audience",
			"pain points",
			"goals",
			"anti-goals",
			// EVAL_VERSION 3: Industry-standard phrases
			"problem statement",
			"proposed solution",
			"expected outcome",
			"SMART goals",
			"given when then",
			"definition of done",
			"out of scope",
			"risk mitigation",
			"stakeholder matrix",
			"functional requirements",
			"non-functional requirements",
			"technical constraints",
			"dependencies",
			"assumptions",
			"release criteria",
			"rollout plan",
			"success criteria",
			"measurement method",
		],
	},
	{
		documentType: "ARCHITECTURE",
		name: "Architecture - Microservices Template",
		requiredSections: [
			"metadata",
			"summary",
			"stakeholders",
			"quality_attributes",
			"cross_cutting",
			"technical",
			"data",
			"security",
			"performance",
			"operations",
			"glossary",
		],
		keyPhrases: [
			"microservices",
			"api gateway",
			"load balancer",
			"service mesh",
			"container orchestration",
			"high availability",
			"scalability",
			"resilience",
			"circuit breaker",
			"distributed tracing",
			"performance",
			"latency",
			"throughput",
			"capacity planning",
		],
	},
	{
		documentType: "TECHNICAL_SPEC",
		name: "Technical Spec - Feature Implementation",
		requiredSections: [
			"metadata",
			"glossary",
			"summary",
			"technical",
			"requirements",
			"data",
			"api",
			"configuration",
			"operations",
			"testing",
			"migration",
		],
		keyPhrases: [
			"implementation",
			"data model",
			"api",
			"database",
			"testing",
			"deployment",
			"migration",
			"rollback",
			"backwards compatibility",
		],
	},
	{
		documentType: "API_SPEC",
		name: "API Spec - RESTful Service",
		requiredSections: [
			"metadata",
			"summary",
			"api",
			"data",
			"security",
			"deprecation",
			"performance",
		],
		keyPhrases: [
			"endpoint",
			"request",
			"response",
			"authentication",
			"authorization",
			"rate limiting",
			"error handling",
			"performance",
			"latency",
		],
	},
	{
		documentType: "USER_STORY",
		name: "User Stories - Feature Set Template",
		requiredSections: ["users", "acceptance"],
		keyPhrases: [
			"As a",
			"I want",
			"So that",
			"Given",
			"When",
			"Then",
			"acceptance criteria",
			"definition of done",
		],
	},
];

async function updateGoldenReferencesV3() {
	console.log("🔄 Updating golden references to EVAL_VERSION 3...\n");

	let updated = 0;
	let skipped = 0;
	let errors = 0;

	for (const update of V3_UPDATES) {
		try {
			// Find existing reference
			const existing = await db.goldenReference.findFirst({
				where: {
					documentType: update.documentType,
					scope: "SYSTEM",
					name: update.name,
				},
			});

			if (!existing) {
				console.log(
					`  ⚠️  Not found: ${update.documentType} - "${update.name}" (skipping)`,
				);
				skipped++;
				continue;
			}

			// Check if update is needed
			const requiredSectionsMatch =
				JSON.stringify(existing.requiredSections?.sort()) ===
				JSON.stringify(update.requiredSections.sort());
			const keyPhrasesMatch =
				JSON.stringify(existing.keyPhrases?.sort()) ===
				JSON.stringify(update.keyPhrases.sort());

			if (requiredSectionsMatch && keyPhrasesMatch) {
				console.log(
					`  ✓ Already up-to-date: ${update.documentType} - "${update.name}"`,
				);
				skipped++;
				continue;
			}

			// Update the reference
			await db.goldenReference.update({
				where: { id: existing.id },
				data: {
					requiredSections: update.requiredSections,
					keyPhrases: update.keyPhrases,
					description: update.description ?? existing.description,
					version: (existing.version ?? 1) + 1,
				},
			});

			console.log(
				`  ✅ Updated ${update.documentType} - "${update.name}"`,
			);
			console.log(
				`     - Required sections: ${update.requiredSections.length} (was ${existing.requiredSections?.length ?? 0})`,
			);
			console.log(
				`     - Key phrases: ${update.keyPhrases.length} (was ${existing.keyPhrases?.length ?? 0})`,
			);
			updated++;
		} catch (error) {
			console.error(
				`  ❌ Failed to update ${update.documentType} - "${update.name}":`,
				error instanceof Error ? error.message : error,
			);
			errors++;
		}
	}

	console.log("\n✨ Update complete!");
	console.log(`   Updated: ${updated}`);
	console.log(`   Skipped: ${skipped}`);
	if (errors > 0) {
		console.log(`   Errors: ${errors}`);
	}
}

// Run if called directly
updateGoldenReferencesV3()
	.catch((error) => {
		console.error("Update failed:", error);
		process.exit(1);
	})
	.finally(async () => {
		await db.$disconnect();
	});

export { updateGoldenReferencesV3 };
