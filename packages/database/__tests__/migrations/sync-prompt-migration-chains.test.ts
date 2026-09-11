/**
 * Drift alarm for every `sync_*` migration that carries a Publishing Suite
 * prompt edit into environments the INSERT-ONLY prompt seed can never reach.
 *
 * Each of those migrations embeds a point-in-time snapshot of a paragraph of
 * an `@repo/utils` prompt constant. A migration is frozen history, so the copy
 * can never be re-synced — the usual reason those constants live in ONE place
 * is precisely to stop copies like it existing. The copies cannot be removed,
 * so they are pinned from the other end: this suite reads the dollar-quoted
 * fragments straight out of the migrations on disk, replays them, and fails if
 * a constant stops agreeing with them.
 *
 * # Why this replaced a per-migration file
 *
 * The file this supersedes (`sync-planning-analysis-linkedin.test.ts`) asserted
 * that ITS OWN new-text fragment appeared in the constant exactly once. That
 * property is true only of the LAST migration in a prompt's chain: the moment a
 * later slice edits the same paragraph, the earlier migration's new text is no
 * longer in the constant and the case is false for an entirely correct change.
 * The chain is the unit that has invariants; a single link is not.
 *
 * # Why it partitions by agent key
 *
 * `sync_planning_analysis_*` and `sync_topic_suggestion_*` name two DIFFERENT
 * prompts, with two different agent keys and two different in-repo constants.
 * One timestamp-ordered list would compare a planning paragraph against a
 * suggestion paragraph and could never pass. The partition key is read from
 * each migration's own `p."key" = '…'` predicate rather than from its folder
 * name, so a migration filed under the wrong prefix is caught rather than
 * silently sorted into the wrong chain.
 *
 * # What this proves, and what it does not
 *
 * `bBefore` and `bAfter` below are RECONSTRUCTIONS walked backwards from the
 * constant, not the body in any database. So everything here establishes the
 * internal consistency of the fragments and says nothing about the row the
 * migration meets in production. That half is
 * `sync-prompt-migrations-apply.test.ts`, which executes the statements against
 * a real Postgres.
 */

import {
	PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY,
	PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY,
} from "@repo/utils/publishing-planning-prompt";
import {
	PUBLISHING_TOPIC_SUGGESTION_AGENT_KEY,
	PUBLISHING_TOPIC_SUGGESTION_FALLBACK_BODY,
} from "@repo/utils/publishing-suggestion-prompt";
import { describe, expect, it } from "vitest";
import {
	discoverSyncPromptChainFolders,
	extractSyncMigrationFragment,
	foldersTargetingPublishingPromptKey,
	readSyncMigrationAgentKey,
	readSyncMigrationGuard,
	readSyncMigrationSql,
	syncPromptMigrationsDir,
} from "../_helpers/sync-prompt-migration-discovery";

/**
 * Agent key → the in-repo constant that chain's last migration must agree with.
 *
 * Keyed on the exported AGENT_KEY constants rather than string literals: a key
 * rename that left a migration behind would otherwise partition into a chain
 * this map has never heard of, and the lookup below fails loudly instead.
 */
const CONSTANT_BY_AGENT_KEY: ReadonlyMap<string, string> = new Map([
	[
		PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY,
		PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY,
	],
	[
		PUBLISHING_TOPIC_SUGGESTION_AGENT_KEY,
		PUBLISHING_TOPIC_SUGGESTION_FALLBACK_BODY,
	],
]);

interface SyncMigration {
	folder: string;
	agentKey: string;
	/** The `$old_types$` fragment: what the statement replaces. */
	replaced: string;
	/** The `$new_types$` fragment: what it writes. */
	replacement: string;
	/** The `G` inside `NOT LIKE '%G%'` — the idempotency guard string. */
	guard: string;
	sql: string;
}

function loadChainMigrations(): SyncMigration[] {
	const dir = syncPromptMigrationsDir();
	return discoverSyncPromptChainFolders(dir).map((folder) => {
		const sql = readSyncMigrationSql(dir, folder);
		return {
			folder,
			agentKey: readSyncMigrationAgentKey(sql, folder),
			replaced: extractSyncMigrationFragment(sql, "old_types", folder),
			replacement: extractSyncMigrationFragment(sql, "new_types", folder),
			guard: readSyncMigrationGuard(sql, folder),
			sql,
		};
	});
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

const ALL = loadChainMigrations();

const CHAINS: Map<string, SyncMigration[]> = new Map();
for (const migration of ALL) {
	const bucket = CHAINS.get(migration.agentKey) ?? [];
	bucket.push(migration);
	CHAINS.set(migration.agentKey, bucket);
}

describe("sync prompt migration chains — discovery", () => {
	it("every discovered migration names an agent key this suite has a constant for", () => {
		// A migration whose key is unknown here is either a new prompt family
		// that needs its constant added, or a typo in the predicate — which
		// would leave the statement targeting nothing at all in production.
		for (const migration of ALL) {
			expect(
				CONSTANT_BY_AGENT_KEY.has(migration.agentKey),
				`${migration.folder} targets '${migration.agentKey}', which has no constant registered in this suite`,
			).toBe(true);
		}
	});

	it("discovers every migration whose statement targets a publishing_topic_* prompt", () => {
		// The negative control on the folder-name pattern discovery runs on.
		// Everything else in this file, and the post-deploy checker's guard
		// binding in `verify-publishing-prompt-sync.test.ts`, is scoped to what
		// that pattern finds — so a prompt-sync migration named outside its two
		// prefixes is not merely uncovered, it is invisible to the case that
		// exists to notice a guard has fallen behind. Both directions of that
		// case would compare two unchanged lists and pass, and
		// `checkPublishingPromptSync` would report OK for an environment the
		// migration never reached.
		//
		// A rewording of one of the seven existence-only publishing keys is how
		// that arrives: the seed is INSERT-ONLY, so the change can only travel
		// as a migration, and nothing obliges its author to pick one of the two
		// prefixes.
		const dir = syncPromptMigrationsDir();
		const discovered = new Set(discoverSyncPromptChainFolders(dir));
		const targeting = foldersTargetingPublishingPromptKey(dir);

		// Floor first, so the assertion below cannot pass vacuously on a scan
		// that has silently stopped matching — an empty scan has an empty
		// difference. Tied to what discovery found rather than to a number, so
		// it grows by itself and nobody has to bump it.
		expect(
			targeting.length,
			"the SQL scan found fewer publishing_topic_* migrations than folder-name discovery did, so the scan itself has stopped working",
		).toBeGreaterThanOrEqual(discovered.size);

		const undiscovered = targeting.filter(
			(folder) => !discovered.has(folder),
		);
		expect(
			undiscovered,
			`these migrations rewrite a publishing_topic_* prompt but are not discovered, so nothing binds a staleness guard to them and the post-deploy checker will report OK for an environment they never reached:\n  ${undiscovered.join("\n  ")}`,
		).toEqual([]);
	});

	it("both prompt chains are non-empty", () => {
		// Without this the whole suite passes vacuously if the folders are ever
		// renamed out of the discovery pattern. The floors only ever grow, so
		// neither is a constant anyone has to remember to bump.
		expect(
			CHAINS.get(PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY)?.length ?? 0,
		).toBeGreaterThanOrEqual(2);
		expect(
			CHAINS.get(PUBLISHING_TOPIC_SUGGESTION_AGENT_KEY)?.length ?? 0,
		).toBeGreaterThanOrEqual(1);
	});
});

for (const [agentKey, chain] of CHAINS) {
	const constant = CONSTANT_BY_AGENT_KEY.get(agentKey);

	describe(`sync migration chain — ${agentKey}`, () => {
		if (constant === undefined) {
			// The discovery suite above reports this properly. Skipping here
			// keeps the failure to one case instead of a wall of thrown
			// lookups, without letting the chain pass silently.
			it.skip("has a registered constant", () => undefined);
			return;
		}

		/**
		 * The body states either side of every migration, walked BACKWARDS from
		 * the constant: `states[i]` is the body migration `i` runs against and
		 * `states[i + 1]` the body it leaves behind, so `states[chain.length]`
		 * is the constant itself.
		 *
		 * Backwards because forwards is not constructible: the earliest
		 * pre-migration state is a paragraph, and no sequence of fragment
		 * replacements turns a paragraph into an 11KB body.
		 */
		const states: string[] = new Array(chain.length + 1);
		states[chain.length] = constant;
		for (let i = chain.length - 1; i >= 0; i--) {
			states[i] = states[i + 1]!.replaceAll(
				chain[i]!.replacement,
				chain[i]!.replaced,
			);
		}

		chain.forEach((migration, i) => {
			const bBefore = states[i]!;
			const bAfter = states[i + 1]!;

			// Assertion 0. First, because 2 and 5 are meaningless otherwise: a
			// nested pair makes `replace()` fire again on a body it has already
			// rewritten, and a twice-occurring fragment is rewritten at both
			// sites by PostgreSQL's global `replace()`.
			it(`${migration.folder}: the fragments do not nest, occur exactly once, and the guard has no LIKE wildcard`, () => {
				expect(migration.replaced.length).toBeGreaterThan(0);
				expect(migration.replacement).not.toBe(migration.replaced);
				expect(migration.replacement).not.toContain(migration.replaced);
				expect(occurrences(bBefore, migration.replaced)).toBe(1);
				expect(occurrences(bAfter, migration.replaced)).toBe(0);
				// `%` and `_` are wildcards to SQL `LIKE` and literals to the
				// `String.includes` this suite checks the guard with, so a
				// guard containing either means two different things at its
				// two ends.
				expect(migration.guard).not.toContain("%");
				expect(migration.guard).not.toContain("_");
			});

			// Assertion 1. Deliberately NOT byte-equality between migration
			// N's new text and migration N+1's old text: that would force every
			// future sync migration to carry the whole accumulated fragment
			// forward, so the first one touching a different paragraph would go
			// red for a correct change.
			if (i > 0) {
				it(`${migration.folder}: the previous migration's new text is still present in the body this one is cut from`, () => {
					expect(bBefore).toContain(chain[i - 1]!.replacement);
				});
			}

			// Assertion 4, in this order so a failure names which half broke.
			it(`${migration.folder}: the guard string is absent before and present after`, () => {
				expect(bBefore).not.toContain(migration.guard);
				expect(bAfter).toContain(migration.guard);
			});

			// Rule 8, and the only one of the `G` rules that is a property of
			// WHERE the string sits rather than of the string itself.
			//
			// The prompt constants are wrapped at 78 columns, so a clause
			// picked out of one to serve as `G` can straddle a line break. The
			// author of 20260910140000 nearly shipped exactly that. Written
			// into the migration it becomes a quoted SQL literal carrying a
			// raw newline — legal, almost never intended, and invisible to
			// every other rule here, because all of them compare `G` against
			// a body reconstructed from that same wrapped constant and so
			// agree with themselves. `toContain` is substring-matching a
			// multi-line string, and a multi-line needle matches it happily.
			//
			// MEASURED, by mutating this migration's guard and counting what
			// went red:
			//
			//  - `G` taken across the wrap WITH the newline kept in the SQL
			//    literal: exactly ONE failure, this case. All seven other
			//    rules pass. This case is the only thing standing between
			//    that authoring slip and a merge.
			//  - the same clause with the newline flattened to a space:
			//    TWO failures, this case and "absent before and present
			//    after". Here rule 8 is a duplicate, not the catcher.
			//
			// What it is NOT for: re-wrapping the paragraph itself is caught
			// many times over already (13 failures across the chain, driven by
			// the frozen `$new_types$` fragment no longer occurring in the
			// reflowed constant). An earlier draft of this comment claimed a
			// re-wrap was "not caught at all"; measurement refuted that, and
			// the claim is not repeated here.
			it(`${migration.folder}: the guard string sits on ONE line of the body it produces`, () => {
				expect(
					bAfter.split("\n").some((l) => l.includes(migration.guard)),
					`guard '${migration.guard}' straddles a line break in the constant, so the SQL literal carries a raw newline and the clause is pinned to one exact wrap position - pick a G that fits on a single line`,
				).toBe(true);
			});

			// The fourth `G` rule: absent from the post-migration body of every
			// EARLIER migration in the chain, not merely from this one's
			// fragment. Both natural guard strings for a type label are already
			// present in an earlier migration's output, which is the trap this
			// case exists for.
			it(`${migration.folder}: the guard string is absent from every earlier state in this chain`, () => {
				for (let k = 0; k <= i; k++) {
					expect(
						states[k]!.includes(migration.guard),
						`guard '${migration.guard}' already appears in the body state before migration ${k} (${chain[k]!.folder})`,
					).toBe(false);
				}
			});

			// Assertion 5, with global replacement so the model matches the
			// engine: PostgreSQL's `replace()` rewrites every occurrence, while
			// JavaScript's `String.replace(string, string)` rewrites only the
			// first and would hide a divergence.
			it(`${migration.folder}: re-applying it to the body it produced is a no-op`, () => {
				expect(
					bAfter.replaceAll(
						migration.replaced,
						migration.replacement,
					),
				).toBe(bAfter);
			});

			it(`${migration.folder}: targets the prompt key the seed actually writes`, () => {
				// The migration names the key as a SQL literal in two places.
				// Renaming the agent key without a new migration would leave
				// every deployed environment's prompt untargeted, and
				// unfixable by this one.
				expect(migration.sql).toContain(`p."key" = '${agentKey}'`);
				expect(migration.sql).toContain(
					`b."targetKey" = '${agentKey}'`,
				);
			});
		});

		// Assertion 2.
		it("only the last migration's new text is in the constant, exactly once", () => {
			const last = chain[chain.length - 1]!;
			expect(occurrences(constant, last.replacement)).toBe(1);
			expect(constant).not.toContain(last.replaced);
			for (const earlier of chain.slice(0, -1)) {
				expect(
					constant.includes(earlier.replacement),
					`${earlier.folder}'s new text is still in the constant, so a later migration did not supersede it — the chain has forked`,
				).toBe(false);
			}
		});

		// Assertion 3.
		it("reverse-applying the whole chain reproduces the earliest replaced text, exactly once", () => {
			expect(occurrences(states[0]!, chain[0]!.replaced)).toBe(1);
		});
	});
}
