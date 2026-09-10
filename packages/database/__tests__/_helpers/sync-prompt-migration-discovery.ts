/**
 * How the Publishing Suite's prompt-sync migrations are found on disk, shared
 * by the two suites that guard them.
 *
 * `sync-prompt-migration-chains.test.ts` replays their dollar-quoted fragments
 * textually; `sync-prompt-migrations-apply.test.ts` executes their statements
 * against real Postgres rows. Both have to agree on WHICH migrations they are
 * talking about, and a second copy of the pattern in the second file is the
 * drift these migrations exist to prevent, reintroduced one level up.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
