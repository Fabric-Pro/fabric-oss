#!/usr/bin/env npx tsx
/**
 * Optimized RLS Deployment Script
 *
 * This script applies RLS policies with hash-based change detection.
 * Only re-applies policies when the RLS script has changed.
 *
 * Usage:
 *   pnpm --filter @repo/database deploy:rls
 *   pnpm --filter @repo/database deploy:rls --force  # Skip hash check
 *
 * Performance Optimizations:
 * 1. Hash-based skip when RLS script hasn't changed
 * 2. Single database connection for all operations
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../prisma/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse args
const args = process.argv.slice(2);
const forceRun = args.includes("--force") || args.includes("-f");

const RLS_SCRIPT_PATH = join(__dirname, "apply-rls-direct.ts");

/**
 * Calculate SHA256 hash of file content, folding in every input that changes what
 * apply-rls-direct.ts applies — so toggling a worker knob forces a re-apply even
 * when the script file itself is unchanged. Without this, e.g. running once in
 * policy mode with the worker disabled stores a hash, and later enabling the
 * worker (WORKER_ROLE_PREPROVISIONED / WORKER_DB_PASSWORD) would NOT change the
 * hash, so deploy:rls skips and never attaches the worker_bypass policies.
 *
 * Inputs folded in:
 * - WORKER_RLS_MODE            — bypassrls vs policy
 * - WORKER_ROLE_PREPROVISIONED — makes workerEnabled true (→ worker_bypass in policy mode)
 * - WORKER_DB_PASSWORD (set?)  — also makes workerEnabled true; only its presence
 *   is folded in (not the secret value), so a password ROTATION won't needlessly
 *   re-run — apply-rls-direct.ts reconciles the role password on the next real run.
 * - APP_RLS_BYPASS             — toggles the app_bypass policy for fabric_app
 *   (managed Postgres hosts, e.g. Databricks Lakebase, where the app role has
 *   no implicit RLS bypass); folding it in forces a re-apply when it flips.
 */
function getFileHash(filePath: string): string {
	const content = readFileSync(filePath, "utf-8");
	const workerRlsMode = (process.env.WORKER_RLS_MODE ?? "bypassrls")
		.trim()
		.toLowerCase();
	const workerPreprovisioned = /^(1|true|yes)$/i.test(
		(process.env.WORKER_ROLE_PREPROVISIONED ?? "").trim(),
	);
	const workerDbPasswordSet = !!process.env.WORKER_DB_PASSWORD;
	const appRlsBypass = (process.env.APP_RLS_BYPASS ?? "false")
		.trim()
		.toLowerCase();
	const rlsInputs = `worker-rls-mode:${workerRlsMode}\nworker-role-preprovisioned:${workerPreprovisioned}\nworker-db-password-set:${workerDbPasswordSet}\napp-rls-bypass:${appRlsBypass}`;
	return createHash("sha256")
		.update(`${content}\n${rlsInputs}`)
		.digest("hex")
		.slice(0, 16);
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
 * Get stored hash
 */
async function getStoredHash(key: string): Promise<string | null> {
	const result = await db.$queryRaw<Array<{ value: string }>>`
		SELECT value FROM "_deployment_metadata" WHERE key = ${key}
	`;
	return result[0]?.value ?? null;
}

/**
 * Store hash
 */
async function storeHash(key: string, hash: string): Promise<void> {
	await db.$executeRaw`
		INSERT INTO "_deployment_metadata" (key, value, updated_at)
		VALUES (${key}, ${hash}, NOW())
		ON CONFLICT (key) DO UPDATE SET value = ${hash}, updated_at = NOW()
	`;
}

/**
 * Main deployment function
 */
async function main() {
	console.log("🔒 Starting optimized RLS deployment...\n");

	const startTime = Date.now();

	// Ensure metadata table exists
	await ensureMetadataTable();

	// Check if RLS script has changed
	const currentHash = getFileHash(RLS_SCRIPT_PATH);
	const storedHash = await getStoredHash("rls:apply-rls-direct");

	if (!forceRun && currentHash === storedHash) {
		console.log("⏭️  RLS policies: Skipped (script unchanged)");
		console.log("   Last applied: check _deployment_metadata table");
		console.log("\n✅ RLS deployment complete! (0ms - skipped)");
		return;
	}

	console.log("🔐 Applying RLS policies...");

	// Import and run the RLS function
	const { applyRLS } = await import("./apply-rls-direct");
	await applyRLS();

	// Store the hash after successful application
	await storeHash("rls:apply-rls-direct", currentHash);

	const totalTime = Date.now() - startTime;
	console.log(`\n✅ RLS deployment complete! (${totalTime}ms)`);
}

main()
	.catch((e) => {
		console.error("RLS deployment failed:", e);
		process.exit(1);
	})
	.finally(() => db.$disconnect());
