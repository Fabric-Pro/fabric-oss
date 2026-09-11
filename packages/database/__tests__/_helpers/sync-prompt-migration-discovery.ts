/**
 * How the Publishing Suite's prompt-sync migrations are found on disk, and how
 * their parts are read out of the SQL, shared by the three suites that guard
 * them.
 *
 * `sync-prompt-migration-chains.test.ts` replays their dollar-quoted fragments
 * textually; `sync-prompt-migrations-apply.test.ts` executes their statements
 * against real Postgres rows; `verify-publishing-prompt-sync.test.ts` binds the
 * post-deploy checker's staleness guards back to them. All three have to agree
 * on WHICH migrations they are talking about AND on how a guard or a fragment
 * is read out of one, and a second copy of either pattern in a second file is
 * the drift these migrations exist to prevent, reintroduced one level up.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The migration-folder prefixes these suites discover, after the timestamp.
 *
 * Discovery rather than a hand-written list, so a new sync migration is
 * covered by the act of naming it conventionally. The agent key it is
 * partitioned under is still read from the SQL, not from this pattern.
 *
 * DELIBERATELY name-shaped, and the alternative was measured. Discovering by
 * SQL structure instead — every migration whose statement is an `UPDATE` on
 * `prompt_version` carrying a `p."key" = '…'` predicate — sweeps in five
 * migrations that predate this family and share none of its conventions
 * (`sync_scan_reviewer_prompts_fp_override`, two `sync_test_case_drafter_*`,
 * two `sync_*_reprioritization_*`). None of them carries an `$old_types$` or
 * `$new_types$` fragment or a `NOT LIKE` guard, and three name two prompt keys
 * rather than one, so the chain suite does not merely fail on them — it throws
 * while building its migration list and registers ZERO cases, which is worse
 * than the omission it was widening to fix. They are frozen history: their
 * files cannot be edited without breaking `prisma migrate deploy`'s checksum
 * in every environment that has applied them.
 *
 * So the omission this pattern leaves open — a future prompt-sync migration
 * named some other valid way is invisible to both suites — is narrowed from
 * the other end instead: the apply suite asserts that every chain this pattern
 * DOES find has an executing fixture, so a migration that lands inside the
 * convention and is only half-covered fails loudly.
 */
const CHAIN_FOLDER_PATTERN =
	/^\d+_(sync_planning_analysis_|sync_topic_suggestion_)/;

/**
 * This package's `prisma/migrations` directory, resolved from THIS file rather
 * than from each caller's own depth under `__tests__/`.
 *
 * The suites that read migrations sit at two different depths, so a per-caller
 * `join(dirname(...), "..", "..")` is right in one file and wrong in the other
 * — and wrong quietly, because `readdirSync` on a missing directory throws at
 * import time and reads as a broken suite rather than a broken path.
 */
export function syncPromptMigrationsDir(): string {
	return join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"prisma",
		"migrations",
	);
}

/** One migration's SQL, by folder name. */
export function readSyncMigrationSql(
	migrationsDir: string,
	folder: string,
): string {
	return readFileSync(join(migrationsDir, folder, "migration.sql"), "utf8");
}

/**
 * One dollar-quoted fragment of a migration, by its tag. The tags are
 * `old_types` (the body text the statement replaces) and `new_types` (what it
 * writes); the prompt bodies carry no `$` of their own, so the delimiters are
 * unambiguous.
 *
 * What comes back is the complete `$old_types$` / `$new_types$` FRAGMENT — the
 * paragraph this migration replaces, and the one it writes — not the whole
 * body, which an earlier version of this docblock claimed. They are the two
 * arguments of a SQL `replace()`: MEASURED, `20260910150000`'s `$old_types$` is
 * 1586 characters against a 5720-character constant, and `20260910140000`'s is
 * 593 against 9675.
 *
 * What makes a fragment worth reading rather than paraphrasing is that it is
 * the only record of that paragraph nobody reconstructed — a fixture written by
 * hand keeps the properties its author remembered and loses the rest. The
 * whole-body states are reconstructed from the `@repo/utils` constant by
 * `sync-prompt-migration-chains.test.ts`, and that is where any property of a
 * whole body is pinned.
 */
export function extractSyncMigrationFragment(
	sql: string,
	tag: "old_types" | "new_types",
	folder: string,
): string {
	const delimiter = `$${tag}$`;
	const start = sql.indexOf(delimiter);
	if (start === -1) {
		throw new Error(`${folder} has no ${delimiter} fragment`);
	}
	const contentStart = start + delimiter.length;
	const end = sql.indexOf(delimiter, contentStart);
	if (end === -1) {
		throw new Error(`${folder}'s ${delimiter} fragment is not closed`);
	}
	return sql.slice(contentStart, end);
}

/**
 * The `G` inside a migration's `NOT LIKE '%G%'` predicate — its idempotency
 * guard, and the single string that decides whether the statement declines a
 * row it has already rewritten.
 *
 * Throws unless there is exactly one. Two would mean the statement guards on a
 * conjunction no reader here models; zero means it guards on nothing and would
 * rewrite an already-migrated body.
 */
export function readSyncMigrationGuard(sql: string, folder: string): string {
	const matches = [...sql.matchAll(/NOT LIKE '%([^']+)%'/g)];
	if (matches.length !== 1) {
		throw new Error(
			`${folder}: expected exactly one \`NOT LIKE\` guard, found ${matches.length}`,
		);
	}
	return matches[0]![1]!;
}

/**
 * Every prompt-sync migration folder, in the order Prisma applies them.
 *
 * Folder names are fixed-width timestamps, so a lexical sort IS timestamp
 * order.
 */
export function discoverSyncPromptChainFolders(
	migrationsDir: string,
): string[] {
	return readdirSync(migrationsDir)
		.filter((entry) => CHAIN_FOLDER_PATTERN.test(entry))
		.sort();
}

/**
 * Every migration folder whose statement carries a
 * `p."key" = 'publishing_topic_…'` predicate, found by reading the SQL rather
 * than the folder name.
 *
 * This is the negative control on `CHAIN_FOLDER_PATTERN` above, and it exists
 * because that pattern became load-bearing beyond the chain suite: the
 * post-deploy checker's freshness guards are bound to disk THROUGH it
 * (`chainLastFoldersByAgentKey` → `discoverSyncPromptChainFolders` → the
 * pattern), so a prompt-sync migration named outside the two prefixes is not
 * merely uncovered here — it is invisible to the binding that is supposed to
 * notice a guard has fallen behind. `checkPublishingPromptSync` would then take
 * its `staleGuardText === undefined` branch and report OK for an environment
 * that migration never reached, with every case in all three suites green.
 *
 * A rewording of any of the SEVEN existence-only keys is the way that arrives.
 * `seed-prompts-only.ts` is INSERT-ONLY, so a change to an already-deployed
 * body can ONLY travel as a migration — the same pressure that has already
 * produced five links across the two chains — and nothing obliges its author to
 * name the folder `sync_planning_analysis_*` or `sync_topic_suggestion_*`.
 *
 * The predicate, not the `UPDATE`-on-`prompt_version` shape: the structural
 * discovery the docblock above deliberately rejected sweeps in five legacy
 * `sync_*` migrations, and those name other prompt keys, so scoping to
 * `publishing_topic_` leaves them alone. MEASURED at the time of writing: 5 of
 * 545 migration folders carry the predicate, and all 5 are already discovered —
 * the control holds today with zero exemptions, and there is no exemption list
 * here to add one to.
 */
export function foldersTargetingPublishingPromptKey(
	migrationsDir: string,
): string[] {
	return readdirSync(migrationsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((folder) => {
			const file = join(migrationsDir, folder, "migration.sql");
			if (!existsSync(file)) {
				return false;
			}
			return /p\."key" = 'publishing_topic_/.test(
				readFileSync(file, "utf8"),
			);
		})
		.sort();
}

/**
 * The single prompt key a sync migration targets, read from its own
 * `p."key" = '…'` predicate.
 *
 * Throws unless there is exactly one. Two keys in one statement would mean
 * this family had grown a shape neither suite models; zero means the predicate
 * was lost, and the statement then targets nothing at all in production.
 */
export function readSyncMigrationAgentKey(sql: string, folder: string): string {
	const matches = [...sql.matchAll(/p\."key" = '([^']+)'/g)];
	if (matches.length !== 1) {
		throw new Error(
			`${folder}: expected exactly one \`p."key" = ...\` predicate, found ${matches.length}`,
		);
	}
	return matches[0]![1]!;
}

/**
 * The LAST migration of each discovered chain, keyed by agent key.
 *
 * Only the last link is meaningful to a suite that executes statements against
 * real rows, and that is a structural fact rather than a coverage gap. An
 * executing fixture reconstructs the body a deployed row still carries by
 * reversing the migration's own substitution against the CURRENT `@repo/utils`
 * constant. For the last link that reversal is exact. For any earlier one it
 * is a no-op — measured on the planning chain: the LinkedIn migration's new
 * text occurs zero times in today's constant, because the webinar migration
 * replaced it, so reversing it changes nothing and the reconstructed "before"
 * body already carries that migration's own `NOT LIKE` guard string. The
 * statement would decline the row, and the fixture would be asserting the
 * opposite of what it claims. Earlier links keep the textual replay in
 * `sync-prompt-migration-chains.test.ts`, which walks the whole chain
 * backwards and does not have this limit.
 */
export function chainLastFoldersByAgentKey(
	migrationsDir: string,
): Map<string, string> {
	const lastByKey = new Map<string, string>();
	for (const folder of discoverSyncPromptChainFolders(migrationsDir)) {
		const sql = readFileSync(
			join(migrationsDir, folder, "migration.sql"),
			"utf8",
		);
		// Later folders overwrite earlier ones, and the list is in apply
		// order, so what survives per key is that chain's last link.
		lastByKey.set(readSyncMigrationAgentKey(sql, folder), folder);
	}
	return lastByKey;
}
