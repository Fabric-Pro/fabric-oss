#!/usr/bin/env npx tsx
/**
 * Find agent instances whose stored workspace list reaches outside their own
 * tenant, and optionally narrow each list to the workspaces that belong.
 *
 * Instance create and update used to accept any workspace the caller could
 * open. A member of two organizations can open both organizations'
 * workspaces, so an instance hosted by one organization could be saved with
 * another organization's workspace, or with its creator's personal one. The
 * write path now refuses that, and execution filters the stored ids against
 * the tenant it runs in before any retrieval, so these rows no longer leak.
 * They are still wrong, though, and this reports them so they can be cleaned
 * up rather than filtered on every run forever.
 *
 * The rule is `partitionWorkspaceIdsForTenant`, the same function the
 * execution path goes through, judged against the instance's own tenant: an
 * organization instance keeps workspaces hosted by that organization, a
 * personal instance keeps only its owner's personal workspaces, and an id with
 * no workspace row is reported as missing. The referenced workspaces are
 * loaded once for the whole sweep.
 *
 * DRY RUN BY DEFAULT. It prints one row per offending id and changes nothing
 * until `--apply` is passed.
 *
 * Usage:
 *   pnpm --filter @repo/database find:cross-tenant-instance-workspaces
 *   pnpm --filter @repo/database find:cross-tenant-instance-workspaces -- --apply
 *
 * `--apply` sets each affected instance's `workspaceIds` to the ids that pass.
 * The instance itself is kept, only the foreign ids leave its list. Each write
 * is conditional on the list still being the one that was read, so an
 * instance edited while this runs is counted as skipped rather than having
 * the edit overwritten; a re-run picks it up.
 */

import { db } from "../prisma/client";
import { partitionWorkspaceIdsForTenant } from "../prisma/queries/workspaces/workspaces";

const args = process.argv.slice(2);
const apply = args.includes("--apply");

async function main(): Promise<void> {
	const instances = await db.agentTemplateInstance.findMany({
		where: { workspaceIds: { isEmpty: false } },
		select: {
			id: true,
			userId: true,
			organizationId: true,
			workspaceIds: true,
		},
	});

	const referencedIds = [
		...new Set(instances.flatMap((instance) => instance.workspaceIds)),
	];
	const workspaces = await db.workspace.findMany({
		where: { id: { in: referencedIds } },
		select: { id: true, userId: true, organizationId: true },
	});
	const workspaceById = new Map(
		workspaces.map((workspace) => [workspace.id, workspace]),
	);

	const rows: Array<{
		instanceId: string;
		instanceOrganizationId: string;
		workspaceId: string;
		workspaceOrganizationId: string;
	}> = [];
	const fixes: Array<{
		id: string;
		read: string[];
		allowed: string[];
	}> = [];

	for (const instance of instances) {
		const { allowed, dropped } = partitionWorkspaceIdsForTenant(
			instance.workspaceIds,
			workspaces,
			{
				userId: instance.userId,
				organizationId: instance.organizationId,
			},
		);
		if (dropped.length === 0) {
			continue;
		}
		fixes.push({ id: instance.id, read: instance.workspaceIds, allowed });
		for (const workspaceId of dropped) {
			const workspace = workspaceById.get(workspaceId);
			rows.push({
				instanceId: instance.id,
				instanceOrganizationId: instance.organizationId ?? "(personal)",
				workspaceId,
				workspaceOrganizationId: workspace
					? (workspace.organizationId ?? "(personal)")
					: "(missing)",
			});
		}
	}

	console.log("\nAgent instances with workspaces outside their tenant");
	console.log("====================================================\n");
	console.log(`Instances with workspaces ...... ${instances.length}`);
	console.log(`Instances affected ............. ${fixes.length}`);
	console.log(`Offending workspace ids ........ ${rows.length}\n`);

	if (fixes.length === 0) {
		console.log("Nothing to fix.\n");
		return;
	}

	console.table(rows);

	if (!apply) {
		console.log(
			"\nDRY RUN — nothing changed. Re-run with --apply to narrow each list to its tenant's workspaces.\n",
		);
		return;
	}

	let updated = 0;
	let skipped = 0;
	for (const fix of fixes) {
		const result = await db.agentTemplateInstance.updateMany({
			where: { id: fix.id, workspaceIds: { equals: fix.read } },
			data: { workspaceIds: fix.allowed },
		});
		if (result.count === 1) {
			updated++;
		} else {
			skipped++;
		}
	}

	console.log(`\nNarrowed ${updated} instances.`);
	if (skipped > 0) {
		console.log(
			`Skipped ${skipped} whose workspace list changed since it was read; re-run to check them again.`,
		);
	}
	console.log("");
}

main()
	.catch((error) => {
		console.error("[find-cross-tenant-instance-workspaces] failed:", error);
		process.exitCode = 1;
	})
	.finally(() => db.$disconnect());
