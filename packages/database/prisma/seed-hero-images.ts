#!/usr/bin/env tsx

/**
 * Seed script to generate AI hero images for existing entities
 *
 * This script triggers hero image generation for entities that don't have one yet.
 * It uses the Temporal workflow for background processing.
 *
 * Usage:
 *   pnpm --filter @repo/database seed:hero-images
 *   pnpm --filter @repo/database seed:hero-images -- --entity=prompt
 *   pnpm --filter @repo/database seed:hero-images -- --entity=all --limit=10
 *
 * Options:
 *   --entity=<type>  Entity type: prompt, agent, workflow, project, mcp-server, all (default: all)
 *   --limit=<n>      Maximum entities per type to process (default: 50)
 *   --dry-run        Show what would be generated without actually generating
 */

import { db } from "./client";

type EntityType = "prompt" | "agent" | "workflow" | "project" | "mcp-server";

interface EntityInfo {
	id: string;
	name: string;
	description: string | null;
	category: string | null;
	tags: string[];
}

// Parse command line arguments
function parseArgs(): {
	entity: EntityType | "all";
	limit: number;
	dryRun: boolean;
} {
	const args = process.argv.slice(2);
	let entity: EntityType | "all" = "all";
	let limit = 50;
	let dryRun = false;

	for (const arg of args) {
		if (arg.startsWith("--entity=")) {
			entity = arg.split("=")[1] as EntityType | "all";
		} else if (arg.startsWith("--limit=")) {
			limit = Number.parseInt(arg.split("=")[1], 10);
		} else if (arg === "--dry-run") {
			dryRun = true;
		}
	}

	return { entity, limit, dryRun };
}

async function getEntitiesNeedingImages(
	entityType: EntityType,
	limit: number,
): Promise<EntityInfo[]> {
	switch (entityType) {
		case "prompt": {
			const prompts = await db.prompt.findMany({
				where: { heroImageUrl: null },
				take: limit,
				select: {
					id: true,
					name: true,
					description: true,
					category: true,
					tags: true,
				},
			});
			return prompts.map((p) => ({
				id: p.id,
				name: p.name,
				description: p.description,
				category: p.category,
				tags: p.tags,
			}));
		}
		case "agent": {
			const agents = await db.agent.findMany({
				where: { heroImageUrl: null },
				take: limit,
				select: {
					id: true,
					displayName: true,
					description: true,
				},
			});
			return agents.map((a) => ({
				id: a.id,
				name: a.displayName,
				description: a.description,
				category: null,
				tags: [],
			}));
		}
		case "workflow": {
			const workflows = await db.workflow.findMany({
				where: { heroImageUrl: null },
				take: limit,
				select: {
					id: true,
					name: true,
					description: true,
				},
			});
			return workflows.map((w) => ({
				id: w.id,
				name: w.name,
				description: w.description,
				category: null,
				tags: [],
			}));
		}
		case "project": {
			const projects = await db.project.findMany({
				where: { heroImageUrl: null },
				take: limit,
				select: {
					id: true,
					name: true,
					description: true,
					tags: true,
				},
			});
			return projects.map((p) => ({
				id: p.id,
				name: p.name,
				description: p.description,
				category: null,
				tags: p.tags,
			}));
		}
		case "mcp-server": {
			const servers = await db.mCPServer.findMany({
				where: { heroImageUrl: null },
				take: limit,
				select: {
					id: true,
					name: true,
					description: true,
					category: true,
					tags: true,
				},
			});
			return servers.map((s) => ({
				id: s.id,
				name: s.name,
				description: s.description,
				category: s.category,
				tags: s.tags,
			}));
		}
		default:
			return [];
	}
}

// Type definition for the Temporal client we need
interface TemporalWorkflowClient {
	workflow: {
		start: (
			workflowType: string,
			options: {
				taskQueue: string;
				workflowId: string;
				args: unknown[];
			},
		) => Promise<unknown>;
	};
}

interface TemporalModule {
	getTemporalClient: () => Promise<TemporalWorkflowClient>;
}

async function triggerImageGeneration(
	entityType: EntityType,
	entity: EntityInfo,
): Promise<boolean> {
	try {
		// Dynamically import Temporal client to avoid circular dependency issues
		// The @repo/temporal package depends on @repo/database, so we can't add it
		// as a direct dependency. Using string variable to bypass TypeScript resolution.
		const modulePath = "@repo/temporal";
		const temporalModule = (await import(modulePath)) as TemporalModule;
		const client = await temporalModule.getTemporalClient();

		const workflowId = `hero-image-seed-${entityType}-${entity.id}`;

		await client.workflow.start("heroImageGenerationWorkflow", {
			taskQueue: "fabric-worker",
			workflowId,
			args: [
				{
					entityType,
					entityId: entity.id,
					name: entity.name,
					description: entity.description,
					category: entity.category,
					tags: entity.tags,
				},
			],
		});

		return true;
	} catch (error) {
		console.error(`  ❌ Failed to trigger for ${entity.name}:`, error);
		return false;
	}
}

async function processEntityType(
	entityType: EntityType,
	limit: number,
	dryRun: boolean,
): Promise<{ processed: number; triggered: number }> {
	console.log(`\n📦 Processing ${entityType}s...`);

	const entities = await getEntitiesNeedingImages(entityType, limit);
	console.log(
		`  Found ${entities.length} ${entityType}(s) without hero images`,
	);

	if (entities.length === 0) {
		return { processed: 0, triggered: 0 };
	}

	let triggered = 0;

	for (const entity of entities) {
		if (dryRun) {
			console.log(
				`  [DRY RUN] Would generate for: "${entity.name}" (${entity.id})`,
			);
			triggered++;
		} else {
			process.stdout.write(`  Triggering for "${entity.name}"...`);
			const success = await triggerImageGeneration(entityType, entity);
			if (success) {
				console.log(" ✅");
				triggered++;
			}
			// Add delay to avoid overwhelming the system
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}

	return { processed: entities.length, triggered };
}

async function main() {
	const { entity, limit, dryRun } = parseArgs();

	console.log("🎨 Hero Image Generation Seeder");
	console.log("================================");
	console.log(`Entity type: ${entity}`);
	console.log(`Limit per type: ${limit}`);
	console.log(`Dry run: ${dryRun}`);

	if (dryRun) {
		console.log("\n⚠️  DRY RUN MODE - No images will be generated\n");
	}

	const entityTypes: EntityType[] =
		entity === "all"
			? ["prompt", "agent", "workflow", "project", "mcp-server"]
			: [entity];

	const results: Record<string, { processed: number; triggered: number }> =
		{};

	for (const type of entityTypes) {
		results[type] = await processEntityType(type, limit, dryRun);
	}

	// Summary
	console.log("\n📊 Summary");
	console.log("==========");
	let totalProcessed = 0;
	let totalTriggered = 0;

	for (const [type, { processed, triggered }] of Object.entries(results)) {
		console.log(`  ${type}: ${triggered}/${processed} triggered`);
		totalProcessed += processed;
		totalTriggered += triggered;
	}

	console.log(
		`\n  Total: ${totalTriggered}/${totalProcessed} workflows triggered`,
	);

	if (!dryRun && totalTriggered > 0) {
		console.log(
			"\n💡 Images are being generated in the background via Temporal.",
		);
		console.log(
			"   Check the Temporal UI or refresh your app in a few minutes.",
		);
	}
}

main()
	.then(() => {
		console.log("\n✨ Seed completed!");
		process.exit(0);
	})
	.catch((error) => {
		console.error("\n❌ Seed failed:", error);
		process.exit(1);
	})
	.finally(() => {
		db.$disconnect();
	});
