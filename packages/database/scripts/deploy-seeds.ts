#!/usr/bin/env npx tsx

/**
 * Optimized Deployment Script for Database Seeds
 *
 * This script checks content hashes before running seeds to skip unchanged ones.
 * Each seed is run as a subprocess to isolate their process.exit() calls.
 *
 * Usage:
 *   pnpm --filter @repo/database deploy:seeds
 *   pnpm --filter @repo/database deploy:seeds --force  # Skip hash checks
 *
 * Performance Optimizations:
 * 1. Content-hash based skipping (only runs when seed data changes)
 * 2. Avoids unnecessary database operations
 * 3. Parallel-safe (uses database table for hash tracking)
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../prisma/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PRISMA_DIR = join(__dirname, "../prisma");
const PKG_ROOT = join(__dirname, "..");

// Parse args
const args = process.argv.slice(2);
const forceRun = args.includes("--force") || args.includes("-f");

interface SeedConfig {
	name: string;
	file: string;
	/** Additional files whose content affects this seed (e.g. imported data catalogs) */
	dependencies?: string[];
	description: string;
}

/**
 * Calculate SHA256 hash of file content, including any dependency files
 */
function getFileHash(filePath: string, depPaths?: string[]): string {
	const hash = createHash("sha256");
	hash.update(readFileSync(filePath, "utf-8"));
	if (depPaths) {
		for (const dep of depPaths) {
			hash.update(readFileSync(dep, "utf-8"));
		}
	}
	return hash.digest("hex").slice(0, 16);
}

/**
 * Ensure the deployment_metadata table exists
 */
async function ensureMetadataTable(): Promise<void> {
	await db.$executeRaw`
		CREATE TABLE IF NOT EXISTS "_deployment_metadata" (
			"key" TEXT PRIMARY KEY,
			"value" TEXT NOT NULL,
			"updated_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		)
	`;
}

/**
 * Get stored hash for a seed
 */
async function getStoredHash(seedName: string): Promise<string | null> {
	const result = await db.$queryRaw<Array<{ value: string }>>`
		SELECT value FROM "_deployment_metadata" WHERE key = ${`seed:${seedName}`}
	`;
	return result[0]?.value ?? null;
}

/**
 * Store hash for a seed
 */
async function storeHash(seedName: string, hash: string): Promise<void> {
	await db.$executeRaw`
		INSERT INTO "_deployment_metadata" (key, value, updated_at)
		VALUES (${`seed:${seedName}`}, ${hash}, NOW())
		ON CONFLICT (key) DO UPDATE SET value = ${hash}, updated_at = NOW()
	`;
}

/**
 * Run a seed script as a subprocess
 */
function runSeed(file: string): void {
	const filePath = join(PRISMA_DIR, file);
	execSync(`npx tsx ${filePath}`, {
		cwd: PKG_ROOT,
		stdio: "inherit",
		env: process.env,
	});
}

/**
 * Main deployment function
 */
async function main() {
	console.log("🚀 Starting optimized seed deployment...\n");

	const startTime = Date.now();

	// Ensure metadata table exists
	await ensureMetadataTable();

	// Define seeds in order (users first, then data seeds)
	const seeds: SeedConfig[] = [
		{
			name: "users",
			file: "seed.ts",
			description: "Test users and organization membership",
		},
		{
			name: "ai-models",
			file: "seed-ai-models.ts",
			dependencies: ["ai-model-catalog.ts"],
			description: "AI model catalog",
		},
		{
			name: "system-agents",
			file: "seed-system-agents.ts",
			description: "System agents",
		},
		{
			name: "agent-templates",
			file: "seed-agent-templates.ts",
			// seed-agent-templates.ts imports DEFAULT_MODELS from ai-model-catalog.ts,
			// so a catalog change (e.g. a new default model) must re-run this seed too.
			dependencies: ["ai-model-catalog.ts"],
			description: "Agent templates",
		},
		{
			name: "skills",
			file: "seed-skills.ts",
			description: "Skill catalog",
		},
		{
			name: "report-templates",
			file: "seed-report-templates.ts",
			description: "Report templates",
		},
		{
			name: "prompts",
			file: "seed-prompts-only.ts",
			description: "System prompts",
		},
		{
			name: "enterprise-mcp",
			file: "seed-enterprise-mcp.ts",
			// Not an import: seed-mcp-registry's cleanupNonOfficialServers()
			// deletes system-provided rows whose key is missing from the curated
			// allowlist, and this seed (ordered before it) is what re-creates
			// them. Re-run it whenever the allowlist changes so a row a previous
			// cleanup deleted (gitlab-official, issue #2824) gets restored.
			dependencies: ["curated-mcp-server-keys.ts"],
			description: "Enterprise MCP servers (Atlassian, Notion, Linear)",
		},
		{
			name: "mcp-registry",
			file: "seed-mcp-registry.ts",
			// seed-mcp-registry.ts imports CURATED_SYSTEM_MCP_SERVER_KEY_SET from
			// curated-mcp-server-keys.ts, so a change to the curated key list must
			// re-run this seed (otherwise the hash is unchanged and it is skipped).
			dependencies: ["curated-mcp-server-keys.ts"],
			description: "Official MCP registry servers",
		},
		{
			// One-time: fills the semantic edit clock for rows that predate it,
			// from recorded change events. Hash-gated like every other entry, so
			// it runs once per environment; also idempotent on its own.
			//
			// LAST on purpose. The runner aborts on the first failure, so
			// whatever runs early can take everything after it down — and this
			// entry did exactly that: it timed out against a production-sized
			// backlog and blocked every catalog seed behind it. The catalog
			// seeds provision what the product needs to function; a historical
			// date backfill does not. Ordering the optional work last bounds the
			// damage when the optional work is what breaks.
			name: "last-edited-at-backfill",
			file: "seed-last-edited-at-backfill.ts",
			// Resolved against PRISMA_DIR like every other dependency entry.
			dependencies: ["../scripts/backfill-last-edited-at.ts"],
			description:
				"Backfill UserStory.lastEditedAt from recorded changes",
		},
	];

	let skipped = 0;
	let executed = 0;

	for (const seed of seeds) {
		const filePath = join(PRISMA_DIR, seed.file);
		const depPaths = seed.dependencies?.map((d) => join(PRISMA_DIR, d));
		const currentHash = getFileHash(filePath, depPaths);
		const storedHash = await getStoredHash(seed.name);

		if (!forceRun && currentHash === storedHash) {
			console.log(`⏭️  ${seed.name}: Skipped (unchanged)`);
			skipped++;
			continue;
		}

		console.log(`🌱 ${seed.name}: Running (${seed.description})...`);
		const seedStart = Date.now();

		try {
			runSeed(seed.file);
			await storeHash(seed.name, currentHash);
			console.log(`   ✓ Completed in ${Date.now() - seedStart}ms`);
			executed++;
		} catch (error) {
			console.error("   ✗ Failed:", error);
			throw error;
		}
	}

	const totalTime = Date.now() - startTime;
	console.log("\n✅ Seed deployment complete!");
	console.log(
		`   Executed: ${executed}, Skipped: ${skipped}, Total time: ${totalTime}ms`,
	);
}

main()
	.catch((e) => {
		console.error("Seed deployment failed:", e);
		process.exit(1);
	})
	.finally(() => db.$disconnect());
