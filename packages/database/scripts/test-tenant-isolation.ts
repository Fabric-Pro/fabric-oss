#!/usr/bin/env npx tsx
// @ts-nocheck - Test script, types from getTenantDb() are dynamic
/**
 * Test Tenant Isolation
 *
 * This script tests that tenant isolation is working correctly.
 *
 * Usage:
 *   pnpm --filter @repo/database test:tenant
 */

import { db } from "../prisma/client";
import {
	createOrganizationContext,
	createPersonalContext,
	getTenantContext,
	runWithTenantContext,
} from "../src/tenant-context";
import { getTenantDb } from "../src/tenant-db";

async function testTenantIsolation() {
	console.log("🧪 Testing Tenant Isolation\n");
	console.log("=".repeat(60));

	// Get some real IDs from the database for testing
	console.log("\n📊 Fetching test data...\n");

	const user = await db.user.findFirst({
		include: {
			members: {
				include: { organization: true },
				take: 1,
			},
		},
	});

	if (!user) {
		console.log(
			"❌ No users found in database. Please seed some data first.",
		);
		return;
	}

	const userId = user.id;
	const orgId = user.members[0]?.organizationId;
	const orgName = user.members[0]?.organization?.name;

	console.log(`   User: ${user.name} (${userId})`);
	if (orgId) {
		console.log(`   Organization: ${orgName} (${orgId})`);
	} else {
		console.log("   Organization: None (personal account only)");
	}

	// Count data for comparison
	const totalMcpConfigs = await db.mCPConfig.count();
	const totalAgents = await db.agent.count();
	const totalProjects = await db.project.count();

	console.log(`\n   Total MCP Configs: ${totalMcpConfigs}`);
	console.log(`   Total Agents: ${totalAgents}`);
	console.log(`   Total Projects: ${totalProjects}`);

	console.log(`\n${"=".repeat(60)}`);
	console.log("\n🔍 Test 1: Query WITHOUT tenant context (raw db)");
	console.log("-".repeat(60));

	const rawConfigs = await db.mCPConfig.findMany({ take: 5 });
	console.log(`   Found ${rawConfigs.length} MCP configs (unfiltered)`);
	if (rawConfigs.length > 0) {
		console.log("   Sample config owners:");
		for (const c of rawConfigs.slice(0, 3)) {
			console.log(
				`   - userId: ${c.userId || "null"}, orgId: ${c.organizationId || "null"}`,
			);
		}
	}

	console.log(`\n${"=".repeat(60)}`);
	console.log("\n🔍 Test 2: Query WITH organization context (getTenantDb)");
	console.log("-".repeat(60));

	if (orgId) {
		await runWithTenantContext(
			createOrganizationContext(orgId, userId),
			async () => {
				const ctx = getTenantContext();
				console.log(
					`   Context: type=${ctx.type}, tenantId=${ctx.tenantId}`,
				);

				const tenantDb = getTenantDb();

				const configs = await tenantDb.mCPConfig.findMany({ take: 10 });
				console.log(
					`   Found ${configs.length} MCP configs for org context`,
				);

				if (configs.length > 0) {
					// MCPConfig is a PER_USER_ORG table - in org context it should have
					// BOTH userId AND organizationId (user's personal config within org)
					const allMatchOrg = configs.every(
						(c) => c.organizationId === orgId && c.userId !== null,
					);
					console.log(
						`   ✓ All configs belong to user in org: ${allMatchOrg ? "YES" : "NO (ISOLATION LEAK!)"}`,
					);
				}

				const agents = await tenantDb.agent.findMany({ take: 10 });
				console.log(`   Found ${agents.length} agents for org context`);
			},
		);
	} else {
		console.log("   ⚠️  Skipped (user has no organization)");
	}

	console.log(`\n${"=".repeat(60)}`);
	console.log("\n🔍 Test 3: Query WITH personal context (getTenantDb)");
	console.log("-".repeat(60));

	await runWithTenantContext(createPersonalContext(userId), async () => {
		const ctx = getTenantContext();
		console.log(`   Context: type=${ctx.type}, tenantId=${ctx.tenantId}`);

		const tenantDb = getTenantDb();

		const configs = await tenantDb.mCPConfig.findMany({ take: 10 });
		console.log(
			`   Found ${configs.length} MCP configs for personal context`,
		);

		if (configs.length > 0) {
			const allMatchUser = configs.every(
				(c) => c.userId === userId && c.organizationId === null,
			);
			console.log(
				`   ✓ All configs belong to user: ${allMatchUser ? "YES" : "NO (ISOLATION LEAK!)"}`,
			);
		}

		const agents = await tenantDb.agent.findMany({ take: 10 });
		console.log(`   Found ${agents.length} agents for personal context`);

		if (agents.length > 0) {
			const allMatchUser = agents.every(
				(a) => a.userId === userId && a.organizationId === null,
			);
			console.log(
				`   ✓ All agents belong to user: ${allMatchUser ? "YES" : "NO (ISOLATION LEAK!)"}`,
			);
		}
	});

	console.log(`\n${"=".repeat(60)}`);
	console.log("\n🔍 Test 4: Cross-context isolation check");
	console.log("-".repeat(60));

	if (orgId) {
		// Create some test data tracking
		let orgConfigCount = 0;
		let personalConfigCount = 0;

		await runWithTenantContext(
			createOrganizationContext(orgId, userId),
			async () => {
				orgConfigCount = await getTenantDb().mCPConfig.count();
			},
		);

		await runWithTenantContext(createPersonalContext(userId), async () => {
			personalConfigCount = await getTenantDb().mCPConfig.count();
		});

		console.log(`   Org context MCP configs: ${orgConfigCount}`);
		console.log(`   Personal context MCP configs: ${personalConfigCount}`);
		console.log(`   Total MCP configs: ${totalMcpConfigs}`);

		if (orgConfigCount + personalConfigCount <= totalMcpConfigs) {
			console.log(
				"   ✓ No overlap detected (good - contexts are isolated)",
			);
		} else {
			console.log("   ⚠️  Counts exceed total - possible isolation issue");
		}
	} else {
		console.log("   ⚠️  Skipped (user has no organization)");
	}

	console.log(`\n${"=".repeat(60)}`);
	console.log("\n✅ Tenant Isolation Test Complete!\n");
}

testTenantIsolation()
	.catch(console.error)
	.finally(() => process.exit(0));
