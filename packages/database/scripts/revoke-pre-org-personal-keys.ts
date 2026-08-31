#!/usr/bin/env npx tsx
/**
 * Revoke personal API keys issued before they resolved into an organization.
 *
 * A `fab_` key used to run with no organization at all. It now resolves through
 * the shared helper, so it reaches everything its owner may reach in the
 * organization it lands in — the largest tenancy class filters that context by
 * organization alone. That is not an escalation beyond the owner's own rights,
 * and it is a change in what the key's disclosure would cost, decided for a
 * credential its holder issued under narrower expectations.
 *
 * The ruling was to revoke rather than to bind or to accept: keys predating the
 * change are deactivated, and their owners issue new ones knowing the reach.
 *
 * DRY RUN BY DEFAULT. It reports what it would revoke and changes nothing until
 * `--apply` is passed. The cutoff is required rather than inferred — only the
 * person running it knows when the resolution change reached the deployment,
 * and guessing it would revoke either too much or too little in silence.
 *
 * Usage:
 *   pnpm --filter @repo/database revoke:pre-org-keys -- --before 2026-08-27T00:00:00Z
 *   pnpm --filter @repo/database revoke:pre-org-keys -- --before 2026-08-27T00:00:00Z --apply
 *
 * Revocation is `isActive: false`, which is what the verifier already checks —
 * the rows are kept so the audit trail and usage counts survive, and so a
 * revocation can be answered for later. Nothing is deleted.
 */

import { db } from "../prisma/client";

const args = process.argv.slice(2);
const apply = args.includes("--apply");

function cutoff(): Date {
	const index = args.indexOf("--before");
	if (index === -1 || !args[index + 1]) {
		console.error(
			"--before <ISO timestamp> is required: the moment key-authenticated callers began resolving into an organization on this deployment.\n" +
				"  e.g. --before 2026-08-27T00:00:00Z",
		);
		process.exit(2);
	}
	const value = new Date(args[index + 1]);
	if (Number.isNaN(value.getTime())) {
		console.error(`--before is not a valid timestamp: ${args[index + 1]}`);
		process.exit(2);
	}
	if (value > new Date()) {
		console.error(
			"--before is in the future, which would revoke every key including ones issued after the change.",
		);
		process.exit(2);
	}
	return value;
}

async function main(): Promise<void> {
	const before = cutoff();

	const where = { isActive: true, createdAt: { lt: before } };

	const [affected, owners, stillActiveAfter] = await Promise.all([
		db.userApiKey.count({ where }),
		db.userApiKey
			.findMany({ where, select: { userId: true }, distinct: ["userId"] })
			.then((rows) => rows.length),
		db.userApiKey.count({
			where: { isActive: true, createdAt: { gte: before } },
		}),
	]);

	console.log("\nPersonal API keys issued before the resolution change");
	console.log("=====================================================\n");
	console.log(`Cutoff ......................... ${before.toISOString()}`);
	console.log(`Active keys older than it ...... ${affected}`);
	console.log(`  belonging to ................. ${owners} users`);
	console.log(
		`Active keys issued after it .... ${stillActiveAfter} (untouched)\n`,
	);

	if (affected === 0) {
		console.log("Nothing to revoke.\n");
		return;
	}

	if (!apply) {
		console.log(
			"DRY RUN — nothing changed. Re-run with --apply to revoke.\n",
		);
		return;
	}

	const result = await db.userApiKey.updateMany({
		where,
		data: { isActive: false },
	});

	console.log(`Revoked ${result.count} keys.`);
	console.log(
		"Rows are kept, not deleted: the usage counts and the audit trail have to survive a revocation for it to be answerable later.\n",
	);
}

main()
	.catch((error) => {
		console.error("[revoke-pre-org-personal-keys] failed:", error);
		process.exitCode = 1;
	})
	.finally(() => db.$disconnect());
