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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
	readSyncMigrationAgentKey,
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

function migrationsDir(): string {
	return join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"prisma",
		"migrations",
	);
}

/**
 * Pull one dollar-quoted fragment out of a migration by its tag. The tags are
 * `$old_types$` and `$new_types$`; the prompt bodies carry no `$` of their own,
 * so the delimiters are unambiguous.
 */
function extractFragment(sql: string, tag: string, folder: string): string {
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

function extractSingle(
	sql: string,
	pattern: RegExp,
	what: string,
	folder: string,
): string {
	const matches = [...sql.matchAll(pattern)];
	if (matches.length !== 1) {
		throw new Error(
			`${folder}: expected exactly one ${what}, found ${matches.length}`,
		);
	}
	return matches[0]![1]!;
}

function loadChainMigrations(): SyncMigration[] {
	const dir = migrationsDir();
	return discoverSyncPromptChainFolders(dir).map((folder) => {
		const sql = readFileSync(join(dir, folder, "migration.sql"), "utf8");
		return {
			folder,
			agentKey: readSyncMigrationAgentKey(sql, folder),
			replaced: extractFragment(sql, "old_types", folder),
			replacement: extractFragment(sql, "new_types", folder),
			guard: extractSingle(
				sql,
				/NOT LIKE '%([^']+)%'/g,
				"`NOT LIKE` guard",
				folder,
			),
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
