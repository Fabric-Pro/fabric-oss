#!/usr/bin/env npx tsx
/**
 * Give every account an organization, without waiting for its owner to sign in.
 *
 * ## Why this exists
 *
 * The rule this epic settles on is that a user is never in a personal
 * environment: they are in an organization, or in the quasi-organization made
 * for them ("[Name]'s workspace"). Signup creates one, and session creation
 * heals accounts that predate it — which covers everyone who comes back.
 *
 * It does not cover anyone who does not. An account that never signs in again
 * keeps no organization at all, and "no organization" IS the personal
 * environment, whatever it is called: nothing to land in, nothing to own, and
 * the drop takes their rows regardless. On staging that was 36 accounts of 69.
 *
 * So this closes the population rather than the code path. Run it once at
 * release, and the sign-in heal goes back to being what it was written as — a
 * safety net rather than the mechanism.
 *
 * ## Ordering
 *
 * Run this BEFORE the drop. A user who gains an organization first loses their
 * personal rows and keeps a workspace; a user dropped first loses the rows and
 * has nowhere to be until they sign in. The order is the whole difference
 * between the two, and it costs one command.
 *
 * Read-only unless `--apply`. Never throws for one account: a failure is
 * reported and the rest continue, because a backfill that stops halfway is
 * worse than one that reports what it could not do.
 *
 * Usage:
 *   DATABASE_URL=... pnpm exec tsx scripts/backfill-user-organizations.ts
 *   DATABASE_URL=... pnpm exec tsx scripts/backfill-user-organizations.ts --apply
 */

import { db } from "@repo/database";

// Relative rather than by package name, matching the drop job beside it: only
// `@repo/temporal` and `@repo/tsconfig` are declared at the repository root, so
// the other workspace packages do not resolve from here. Declaring them would
// be an install; a path is enough for a script.
import { seedDefaultMcpConfigsForTenant } from "../packages/agent-core/src/backend";
import { ensureUserHasOrganization } from "../packages/auth/lib/ensure-user-organization";

const apply = process.argv.includes("--apply");

type Outcome = {
	userId: string;
	email: string;
	status: "created" | "already-had-one" | "failed";
	organizationId?: string;
};

async function main(): Promise<void> {
	const startedAt = new Date().toISOString();

	const withoutOrganization = await db.user.findMany({
		where: { members: { none: {} } },
		select: { id: true, email: true, createdAt: true },
		orderBy: { createdAt: "asc" },
	});

	const total = await db.user.count();

	console.log(
		`\n${apply ? "BACKFILL" : "DRY RUN —"} organizations for accounts that have none` +
			`\n  users ................ ${total}` +
			`\n  without one .......... ${withoutOrganization.length}\n`,
	);

	if (withoutOrganization.length === 0) {
		console.log("Every account already has an organization.\n");
		return;
	}

	if (!apply) {
		for (const user of withoutOrganization.slice(0, 20)) {
			console.log(
				`  would create for ${user.email} (joined ${user.createdAt.toISOString().slice(0, 10)})`,
			);
		}
		if (withoutOrganization.length > 20) {
			console.log(`  … and ${withoutOrganization.length - 20} more`);
		}
		console.log("\nDry run — nothing was created. Re-run with --apply.\n");
		return;
	}

	const outcomes: Outcome[] = [];
	for (const user of withoutOrganization) {
		try {
			// The same helper signup and sign-in use. One implementation means
			// a backfilled organization is indistinguishable from one made at
			// signup — same naming, same slug rule, same seeded defaults.
			const organizationId = await ensureUserHasOrganization(
				user.id,
				seedDefaultMcpConfigsForTenant,
			);
			outcomes.push(
				organizationId
					? {
							userId: user.id,
							email: user.email,
							status: "created",
							organizationId,
						}
					: {
							userId: user.id,
							email: user.email,
							status: "already-had-one",
						},
			);
		} catch (error) {
			// `ensureUserHasOrganization` does not throw, so reaching here means
			// something below it did. Reported, not fatal: the next account is
			// unaffected by this one.
			console.error(`  FAILED ${user.email} — ${String(error)}`);
			outcomes.push({
				userId: user.id,
				email: user.email,
				status: "failed",
			});
		}
	}

	const counts = outcomes.reduce<Record<string, number>>((acc, outcome) => {
		acc[outcome.status] = (acc[outcome.status] ?? 0) + 1;
		return acc;
	}, {});

	console.log(
		`\n  created ${counts.created ?? 0}` +
			`, already had one ${counts["already-had-one"] ?? 0}` +
			`, failed ${counts.failed ?? 0}`,
	);
	console.log(`  started ${startedAt}, finished ${new Date().toISOString()}`);

	const stillWithout = await db.user.count({
		where: { members: { none: {} } },
	});
	console.log(
		stillWithout === 0
			? "\nEvery account now has an organization.\n"
			: `\n${stillWithout} account(s) still have none — see the failures above.\n`,
	);
}

main()
	.catch((error) => {
		console.error("[backfill-user-organizations] failed:", error);
		process.exitCode = 1;
	})
	.finally(() => db.$disconnect());
