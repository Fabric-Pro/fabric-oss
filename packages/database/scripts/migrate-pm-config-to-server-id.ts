/**
 * Migration Script: Convert projectManagementMcpConfigId to projectManagementMcpServerId
 *
 * SECURITY FIX: This migration addresses a security flaw where all users in a project
 * were sharing the admin's MCP credentials for PM tool sync operations.
 *
 * The fix:
 * 1. Projects now store mcpServerId (the server template) instead of mcpConfigId (user's specific config)
 * 2. At sync time, each user's own MCP config is resolved based on the server ID
 * 3. Users who haven't configured their own connection will see an error prompting them to set it up
 *
 * This script:
 * 1. Finds all projects with projectManagementMcpConfigId set
 * 2. Looks up the mcpServerId from the MCPConfig
 * 3. Updates the project with projectManagementMcpServerId
 * 4. Does NOT clear projectManagementMcpConfigId (kept for backward compatibility during rollout)
 *
 * Run with: npx tsx scripts/migrate-pm-config-to-server-id.ts
 */

import { db } from "../prisma/client";

const prisma = db;

interface MigrationResult {
	projectId: string;
	projectName: string;
	organizationId: string | null;
	oldConfigId: string;
	newServerId: string | null;
	status: "success" | "skipped" | "error";
	error?: string;
}

async function migrateProjects(): Promise<void> {
	console.log("=".repeat(80));
	console.log("PM Config to Server ID Migration");
	console.log("=".repeat(80));
	console.log("");
	console.log(
		"This script migrates projects from storing MCP Config IDs to Server IDs.",
	);
	console.log(
		"This is a SECURITY FIX to ensure each user uses their own credentials.",
	);
	console.log("");

	// Find all projects with PM config set but no server ID
	const projectsToMigrate = await prisma.project.findMany({
		where: {
			projectManagementMcpConfigId: { not: null },
			projectManagementMcpServerId: null,
		},
		select: {
			id: true,
			name: true,
			organizationId: true,
			projectManagementMcpConfigId: true,
		},
	});

	console.log(`Found ${projectsToMigrate.length} projects to migrate.`);
	console.log("");

	if (projectsToMigrate.length === 0) {
		console.log("Nothing to migrate. All projects are up to date.");
		return;
	}

	const results: MigrationResult[] = [];

	for (const project of projectsToMigrate) {
		// biome-ignore lint/style/noNonNullAssertion: projectManagementMcpConfigId exists per the WHERE filter above
		const configId = project.projectManagementMcpConfigId!;

		try {
			// Look up the MCP config to get the server ID
			const mcpConfig = await prisma.mCPConfig.findUnique({
				where: { id: configId },
				select: { mcpServerId: true },
			});

			if (!mcpConfig) {
				// Config was deleted - project PM integration is already broken
				results.push({
					projectId: project.id,
					projectName: project.name,
					organizationId: project.organizationId,
					oldConfigId: configId,
					newServerId: null,
					status: "skipped",
					error: "MCP Config not found (may have been deleted)",
				});
				continue;
			}

			// Update the project with the server ID
			await prisma.project.update({
				where: { id: project.id },
				data: {
					projectManagementMcpServerId: mcpConfig.mcpServerId,
				},
			});

			results.push({
				projectId: project.id,
				projectName: project.name,
				organizationId: project.organizationId,
				oldConfigId: configId,
				newServerId: mcpConfig.mcpServerId,
				status: "success",
			});

			console.log(`✓ Migrated: ${project.name} (${project.id})`);
		} catch (error) {
			results.push({
				projectId: project.id,
				projectName: project.name,
				organizationId: project.organizationId,
				oldConfigId: configId,
				newServerId: null,
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			});

			console.error(`✗ Failed: ${project.name} (${project.id})`);
			console.error(`  Error: ${error}`);
		}
	}

	// Summary
	console.log("");
	console.log("=".repeat(80));
	console.log("Migration Summary");
	console.log("=".repeat(80));

	const successful = results.filter((r) => r.status === "success");
	const skipped = results.filter((r) => r.status === "skipped");
	const failed = results.filter((r) => r.status === "error");

	console.log(`Total projects: ${results.length}`);
	console.log(`  ✓ Successful: ${successful.length}`);
	console.log(`  - Skipped: ${skipped.length}`);
	console.log(`  ✗ Failed: ${failed.length}`);

	if (skipped.length > 0) {
		console.log("");
		console.log("Skipped projects (MCP config deleted):");
		for (const r of skipped) {
			console.log(`  - ${r.projectName} (${r.projectId}): ${r.error}`);
		}
	}

	if (failed.length > 0) {
		console.log("");
		console.log("Failed projects:");
		for (const r of failed) {
			console.log(`  - ${r.projectName} (${r.projectId}): ${r.error}`);
		}
	}

	console.log("");
	console.log(
		"IMPORTANT: After this migration, users will need to have their",
	);
	console.log(
		"own MCP connection configured to sync stories. If they don't,",
	);
	console.log("they will see an error message prompting them to set it up.");
}

async function main(): Promise<void> {
	try {
		await migrateProjects();
	} catch (error) {
		console.error("Migration failed:", error);
		process.exit(1);
	}
}

main();
