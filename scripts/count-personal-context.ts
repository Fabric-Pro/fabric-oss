#!/usr/bin/env npx tsx
/**
 * Count what personal context actually holds.
 *
 * The surface map records `population not instrumented` against every decision
 * it asks for: it enumerates the categories personal scope carries — projects,
 * documents, chats, purchases, credit accounts, API keys, the audit trail —
 * without ever counting a row in them. That leaves three questions the
 * elimination cannot answer from the schema alone:
 *
 *   How much is actually there?
 *   How many people have no organization to be moved to?
 *   How many credentials resolve to nothing once personal context is gone?
 *
 * Read-only. It writes nothing and locks nothing.
 *
 * The model list and the personal encoding both come from
 * `lib/personal-context-models`, shared with the drop job. They were written
 * apart and immediately disagreed — the drop job knew two tables encode
 * personal as an empty string and this did not — and a count that disagrees
 * with the delete is worse than either alone, because the disagreement is what
 * gets believed.
 *
 * Usage:
 *   pnpm exec tsx scripts/count-personal-context.ts
 *   pnpm exec tsx scripts/count-personal-context.ts --json
 *
 * `--json` prints a machine-readable object instead of the table, so a figure
 * can be quoted into a decision record without being retyped.
 */

import { db } from "@repo/database";
import {
	delegateFor,
	personalBearingModels,
	personalWhere,
} from "./lib/personal-context-models";

type ModelCount = {
	model: string;
	personalRows: number;
	/** Distinct users holding at least one personal row, where countable. */
	distinctUsers: number | null;
	/** Set when the model could not be counted, with the reason. */
	uncounted?: string;
};

type Delegate = {
	count: (args: { where: unknown }) => Promise<number>;
	findMany: (args: {
		where: unknown;
		select: unknown;
		distinct: string[];
	}) => Promise<{ userId: string | null }[]>;
};

const json = process.argv.includes("--json");

async function countModels(): Promise<ModelCount[]> {
	const results: ModelCount[] = [];

	for (const model of personalBearingModels()) {
		const delegate = delegateFor<Delegate>(
			db as unknown as Record<string, unknown>,
			model.name,
		);
		if (!delegate) {
			results.push({
				model: model.name,
				personalRows: Number.NaN,
				distinctUsers: null,
				uncounted: "no Prisma delegate for this model",
			});
			continue;
		}

		const where = personalWhere(model);

		try {
			const personalRows = await delegate.count({ where });
			if (personalRows === 0) {
				continue;
			}

			let distinctUsers: number | null = null;
			if (model.hasUserId) {
				const rows = await delegate.findMany({
					where,
					select: { userId: true },
					distinct: ["userId"],
				});
				distinctUsers = rows.filter((row) => row.userId).length;
			}

			results.push({
				model: model.name,
				personalRows,
				distinctUsers,
			});
		} catch (error) {
			// Reported with its reason, never swallowed. A silent skip would
			// understate the total, and understating it is the one failure an
			// inventory cannot have — it would read as reassurance.
			results.push({
				model: model.name,
				personalRows: Number.NaN,
				distinctUsers: null,
				uncounted:
					(error as Error).message.split("\n")[0] || "unknown error",
			});
		}
	}

	return results.sort((a, b) => b.personalRows - a.personalRows);
}

async function main(): Promise<void> {
	const [
		models,
		totalUsers,
		usersWithoutMembership,
		usersWithNoLastActive,
		personalApiKeys,
		strandedKeys,
	] = await Promise.all([
		countModels(),
		db.user.count(),
		db.user.count({ where: { members: { none: {} } } }),
		db.user.count({ where: { lastActiveOrganizationId: null } }),
		db.userApiKey.count().catch(() => Number.NaN),
		db.userApiKey
			.count({ where: { user: { members: { none: {} } } } })
			.catch(() => Number.NaN),
	]);

	const counted = models.filter((m) => !m.uncounted);
	const uncounted = models.filter((m) => m.uncounted);
	const totalPersonalRows = counted.reduce(
		(sum, m) => sum + m.personalRows,
		0,
	);
	const scanned = personalBearingModels().length;

	if (json) {
		console.log(
			JSON.stringify(
				{
					totalPersonalRows,
					modelsScanned: scanned,
					modelsWithPersonalRows: counted.length,
					uncountedModels: uncounted.map((m) => ({
						model: m.model,
						reason: m.uncounted,
					})),
					users: {
						total: totalUsers,
						withoutMembership: usersWithoutMembership,
						withNoLastActiveOrganization: usersWithNoLastActive,
					},
					personalApiKeys: {
						total: personalApiKeys,
						ownedByUserWithoutMembership: strandedKeys,
					},
					models: counted,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log("\nPersonal-context inventory");
	console.log("==========================\n");

	console.log(`Users .......................... ${totalUsers}`);
	console.log(`  with no organization ......... ${usersWithoutMembership}`);
	console.log(`  with no last-active org ...... ${usersWithNoLastActive}`);
	console.log(`Personal API keys .............. ${personalApiKeys}`);
	console.log(`  owned by the above users ..... ${strandedKeys}`);
	console.log(
		`\nModels able to hold personal ... ${scanned}` +
			`\nModels holding any ............. ${counted.length} (${totalPersonalRows} rows)\n`,
	);

	if (counted.length > 0) {
		const width = Math.max(...counted.map((m) => m.model.length));
		for (const { model, personalRows, distinctUsers } of counted) {
			const users =
				distinctUsers === null ? "" : `  (${distinctUsers} users)`;
			console.log(
				`  ${model.padEnd(width)}  ${String(personalRows).padStart(8)}${users}`,
			);
		}
	} else {
		console.log("  none");
	}

	if (uncounted.length > 0) {
		console.log(
			`\nUncounted (${uncounted.length}) — these are NOT zero, they failed to count:`,
		);
		for (const { model, uncounted: reason } of uncounted) {
			console.log(`  ${model} — ${reason}`);
		}
	}

	console.log("");
}

main()
	.catch((error) => {
		console.error("[count-personal-context] failed:", error);
		process.exitCode = 1;
	})
	.finally(() => db.$disconnect());
