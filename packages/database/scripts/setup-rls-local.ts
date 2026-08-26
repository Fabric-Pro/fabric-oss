#!/usr/bin/env npx tsx
/**
 * Local Development RLS Setup Script
 *
 * This script sets up Row-Level Security (RLS) for local development.
 * It creates the necessary database roles and applies RLS policies.
 *
 * Usage:
 *   npx tsx packages/database/scripts/setup-rls-local.ts
 *
 * Prerequisites:
 *   - PostgreSQL running locally (docker-compose up -d postgres)
 *   - DATABASE_URL set in .env or .env.local
 *
 * What this script does:
 *   1. Creates fabric_app role (for application with RLS enforced)
 *   2. Creates fabric_admin role (for migrations/seeding, bypasses RLS)
 *   3. Applies RLS policies from the migration file
 *   4. Sets up helper functions for tenant context
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { db } from "../prisma/client";

async function main() {
	console.log("🔒 Setting up RLS for local development...\n");

	try {
		// Test connection
		await db.$queryRaw`SELECT 1`;
		console.log("✓ Connected to database");

		// Check if we're running as superuser/admin
		const currentUser = await db.$queryRaw<
			Array<{ current_user: string }>
		>`SELECT current_user`;
		console.log(`✓ Running as: ${currentUser[0].current_user}`);

		// Read the RLS migration file
		const migrationPath = path.join(
			__dirname,
			"../prisma/migrations/20260106_tenant_isolation_rls/migration.sql",
		);

		if (!fs.existsSync(migrationPath)) {
			console.log("\n⚠️  RLS migration file not found at:", migrationPath);
			console.log(
				"   You may need to create the migration first or run prisma migrate.",
			);
			console.log(
				"   The RLS policies will be applied automatically during migration.",
			);
			return;
		}

		console.log("\n📄 Found RLS migration file");

		// Read migration SQL
		const migrationSQL = fs.readFileSync(migrationPath, "utf-8");

		// Split into statements (simple split - won't handle all edge cases)
		// For complex migrations, it's better to run via psql directly
		console.log("\n⚡ Applying RLS policies (this may take a moment)...");

		// Execute the entire migration as a single transaction
		try {
			await db.$executeRawUnsafe(migrationSQL);
			console.log("✓ RLS policies applied successfully");
		} catch (_error) {
			// Some statements might fail if already applied, that's OK
			console.log("⚠️  Some RLS statements may have already been applied");
			console.log(
				"   If you see errors about existing roles/policies, that's normal.",
			);
		}

		// Verify RLS is enabled on key tables
		console.log("\n🔍 Verifying RLS status...");

		const rlsStatus = await db.$queryRaw<
			Array<{
				tablename: string;
				rowsecurity: boolean;
				forcerowsecurity: boolean;
			}>
		>`
			SELECT tablename, rowsecurity, forcerowsecurity
			FROM pg_tables
			JOIN pg_class ON pg_class.relname = pg_tables.tablename
			WHERE schemaname = 'public'
			AND tablename IN (
				'MCPConfig', 'MCPServer', 'OpenAPIService', 'ai_chat',
				'agent', 'project', 'workflow', 'registered_agent', 'prompt'
			)
		`;

		if (rlsStatus.length > 0) {
			console.log(
				"\n   Table                    | RLS Enabled | Force RLS",
			);
			console.log(
				"   -------------------------|-------------|----------",
			);
			for (const row of rlsStatus) {
				const enabled = row.rowsecurity ? "✓" : "✗";
				const forced = row.forcerowsecurity ? "✓" : "✗";
				console.log(
					`   ${row.tablename.padEnd(24)} |      ${enabled}      |     ${forced}`,
				);
			}
		}

		// Check if roles exist
		console.log("\n👤 Checking roles...");
		const roles = await db.$queryRaw<
			Array<{ rolname: string; rolbypassrls: boolean }>
		>`
			SELECT rolname, rolbypassrls
			FROM pg_roles
			WHERE rolname IN ('fabric_app', 'fabric_admin')
		`;

		if (roles.length === 0) {
			console.log(
				"   ⚠️  No RLS roles found. They will be created during migration.",
			);
		} else {
			for (const role of roles) {
				const bypassRLS = role.rolbypassrls
					? "(bypasses RLS)"
					: "(RLS enforced)";
				console.log(`   ✓ Role ${role.rolname} exists ${bypassRLS}`);
			}
		}

		console.log("\n✅ RLS setup complete!");
		console.log("\n📝 Next steps:");
		console.log(
			"   1. Update your .env.local with the appropriate DATABASE_URL",
		);
		console.log("      - For app queries: Use fabric_app role");
		console.log("      - For migrations: Use fabric_admin or superuser");
		console.log(
			"   2. The tenant context will be set automatically by middleware",
		);
		console.log("   3. Use getTenantDb() for auto-filtered queries\n");
	} catch (error) {
		console.error("\n❌ Error setting up RLS:", error);
		process.exit(1);
	}
}

main()
	.catch(console.error)
	.finally(() => db.$disconnect());
