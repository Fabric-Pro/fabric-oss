/**
 * `checkPublishingPromptSync` against an in-memory fake — no live database.
 *
 * The function under test takes its database access as an injected
 * three-method interface (`PublishingPromptSyncDb`), so every case here is a
 * plain async function backed by in-memory arrays. Nothing imports
 * `../prisma/client` or touches `DATABASE_URL`; there is no `hasReachableDatabaseUrl()`
 * gate anywhere in this file because there is nothing here that needs one.
 *
 * # Why the bodies come off disk and the guards are not re-typed here
 *
 * This file used to carry hand-copied guard fragments and short sentences built
 * around them. Both halves of that were measured wrong, from opposite
 * directions:
 *
 *  - A hand-copied guard agrees with whatever the author copied it from. If a
 *    later slice adds a sync migration and opens neither file, the script's
 *    guard and this file's copy stay in step with EACH OTHER while both fall
 *    behind the migration — every case green, the post-deploy checker green on
 *    an environment the new migration never reached. That is not hypothetical;
 *    it is the path slices 2D-1 and 2D-2 both took. So the guard is no longer
 *    typed here at all: it is read out of the newest migration in each chain,
 *    and one case asserts `CHECKS` agrees with it.
 *  - An abbreviated fixture keeps the properties its author remembered and
 *    loses the ones they did not think of. MEASURED: set the topic-suggestion
 *    guard to `"rather than"` and the real pre-migration body contains it, so
 *    the checker returns OK for an environment still on the old body — while a
 *    fixture reading "A Webinar / Demo Script is … someone presents." happens
 *    not to contain `rather than` and still reports STALE. Guard broken, every
 *    case green. Text nobody rewrote is the only fixture that does not forget,
 *    so the stale and fresh fixtures below are the migration's complete
 *    `$old_types$` and `$new_types$` FRAGMENTS — the paragraph either side of
 *    the statement, not the whole body — neither of them constructed from the
 *    value under test. See `ChainedKeyBodies` for what a fragment can and
 *    cannot pin.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/verify-publishing-prompt-sync.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
	CHECKS,
	checkPublishingPromptSync,
	type PublishingPromptSyncDb,
} from "../scripts/verify-publishing-prompt-sync";
import {
	chainLastFoldersByAgentKey,
	extractSyncMigrationFragment,
	readSyncMigrationGuard,
	readSyncMigrationSql,
	syncPromptMigrationsDir,
} from "./_helpers/sync-prompt-migration-discovery";

const WEBINAR_SCRIPT_KEY = "publishing_topic_webinar_script";
const NEWSLETTER_BLURB_KEY = "publishing_topic_newsletter_blurb";
const PLANNING_ANALYSIS_KEY = "publishing_topic_planning_analysis";
const TOPIC_SUGGESTION_KEY = "publishing_topic_suggestion";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `seed-prompts-only.ts` as TEXT rather than as a module.
 *
 * It does `import { db } from "../prisma/client"` at module scope, so importing
 * it would pull the Prisma client into a file whose whole premise is that it
 * needs none. Reading it as text is the move the migration helper next door
 * already makes for SQL, and the one `prompt-catalog-covers-seeds.test.ts`
 * makes for this very file.
 */
const SEED_SOURCE = readFileSync(
	join(PACKAGE_ROOT, "prisma", "seed-prompts-only.ts"),
	"utf8",
);

/**
 * The value of an agent-key CONSTANT the seed references, read out of the
 * `@repo/utils` module the seed itself imports it from.
 *
 * None of the publishing keys is a string literal in the seed: every one is a
 * computed key (`[PUBLISHING_BLOG_POST_AGENT_KEY]: { ... }`) so the seed, the
 * prompt catalog and the Temporal activity cannot drift apart. A parse that
 * read only quoted literals would therefore find NONE of them and derive an
 * empty family.
 *
 * Every failure below THROWS. A resolver that returned `undefined` for a name
 * it did not recognise would drop that key out of the derived list — and the
 * derived list is the expectation `CHECKS` is measured against, so a silent
 * drop would render a missing check as agreement. That is the exact defect this
 * derivation exists to replace, so it must not be reintroduced inside it.
 */
function resolveSeedKeyConstant(name: string): string {
	const imported = [
		...SEED_SOURCE.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)";/g),
	].find((match) => new RegExp(`\\b${name}\\b`).test(match[1]!));
	if (imported === undefined) {
		throw new Error(
			`the seed uses agent-key constant ${name} but imports no such name - this parse cannot resolve it, and dropping it would silently shrink the family CHECKS is measured against`,
		);
	}
	const utilsModule = imported[2]!.match(/^@repo\/utils\/(.+)$/);
	if (utilsModule === null) {
		throw new Error(
			`${name} is imported from '${imported[2]}', which this parse cannot read - it resolves @repo/utils/* only. Teach it that module rather than leaving the key out of coverage.`,
		);
	}
	const source = readFileSync(
		join(PACKAGE_ROOT, "..", "utils", "lib", `${utilsModule[1]}.ts`),
		"utf8",
	);
	const declared = source.match(
		new RegExp(`export const ${name}\\s*=\\s*"([^"]*)"`),
	);
	if (declared === null) {
		throw new Error(
			`${name} is imported from '${imported[2]}' but that module declares no string constant of that name`,
		);
	}
	return declared[1]!;
}

/**
 * Every `publishing_topic_*` key `seed-prompts-only.ts` writes, DERIVED from
 * the seed on disk.
 *
 * This was a literal array of nine strings. The script's header claims its two
 * lists TOGETHER are the whole family, so that a PASS means what an operator
 * will read it as meaning — and a hand-written array cannot carry that claim,
 * for the reason this file's header already gives about hand-copied guards.
 * The array and `CHECKS` were maintained by the same hand: a tenth content type
 * leaves BOTH at nine, they agree with EACH OTHER, every case passes, and the
 * script prints a family-wide PASS over a key it never asked about. Phase 2D
 * has added one content type per slice, so that is the next event rather than a
 * hypothetical one.
 *
 * Both halves of the seed's registration are read: the `key:` of each
 * `SYSTEM_PROMPTS` row (the prompt row the seed creates) and the `targetKey:`
 * of each `PROMPT_DOCUMENT_TYPE_BINDINGS` entry (the binding that points at
 * it). `checkPublishingPromptSync` asks about both, so either one arriving
 * alone has to move what this file expects.
 */
function seededPublishingKeys(): string[] {
	const keys = new Set<string>();
	for (const match of SEED_SOURCE.matchAll(
		/\b(?:key|targetKey):\s*"([a-z0-9_]+)"/g,
	)) {
		keys.add(match[1]!);
	}
	for (const match of SEED_SOURCE.matchAll(
		/\b(?:key|targetKey):\s*([A-Z][A-Z0-9_]*)\s*,/g,
	)) {
		keys.add(resolveSeedKeyConstant(match[1]!));
	}
	const publishing = [...keys]
		.filter((key) => key.startsWith("publishing_topic_"))
		.sort();
	if (publishing.length === 0) {
		// Guards the guard. With the derived list on the EXPECTATION side an
		// empty parse is already red, but it is red as a confusing diff; this
		// names the cause where it happens.
		throw new Error(
			"parsed zero publishing_topic_* keys out of seed-prompts-only.ts - the parse has stopped matching the seed",
		);
	}
	return publishing;
}

/** Sorted, so a sorted report can be compared against it directly. */
const SEEDED_PUBLISHING_KEYS = seededPublishingKeys();

const MIGRATIONS_DIR = syncPromptMigrationsDir();

/**
 * Agent key → the LAST sync migration in that key's chain, discovered on disk.
 * The same authority the chain suite next door partitions on, so a new sync
 * migration changes what this file expects by the act of being added.
 */
const CHAIN_LAST_FOLDER_BY_KEY = chainLastFoldersByAgentKey(MIGRATIONS_DIR);

/**
 * The two dollar-quoted FRAGMENTS of the newest migration in a key's chain —
 * the paragraph it replaces and the paragraph it writes. Not the whole prompt
 * body, which an earlier version of this docblock claimed: they are the two
 * arguments of a SQL `replace()`, and each is a minority of the constant it was
 * cut from. MEASURED: `20260910150000`'s `$old_types$` is 1586 characters
 * against a 5720-character topic-suggestion constant, and `20260910140000`'s is
 * 593 against 9675.
 *
 * A fragment is enough for what THIS file asks, because
 * `checkPublishingPromptSync` decides staleness with a substring test and a
 * fragment answers it the same way a body would. What a fragment cannot carry
 * is a whole-body property — that the guard occurs nowhere else in the 9675
 * characters, say — and this file does not rest on one. That is pinned next
 * door, by the chain suite's "the guard string is absent before and present
 * after" case, which runs against bodies reconstructed IN FULL from the
 * `@repo/utils` constant and is not DB-gated.
 */
interface ChainedKeyBodies {
	/** The `$old_types$` fragment: the paragraph the migration runs AGAINST. */
	before: string;
	/** The `$new_types$` fragment: the paragraph it leaves BEHIND. */
	after: string;
}

function chainedKeyBodies(key: string): ChainedKeyBodies {
	const folder = CHAIN_LAST_FOLDER_BY_KEY.get(key);
	if (folder === undefined) {
		throw new Error(
			`no sync-prompt migration chain on disk targets '${key}'`,
		);
	}
	const sql = readSyncMigrationSql(MIGRATIONS_DIR, folder);
	return {
		before: extractSyncMigrationFragment(sql, "old_types", folder),
		after: extractSyncMigrationFragment(sql, "new_types", folder),
	};
}

const TOPIC_SUGGESTION_BODIES = chainedKeyBodies(TOPIC_SUGGESTION_KEY);
const PLANNING_ANALYSIS_BODIES = chainedKeyBodies(PLANNING_ANALYSIS_KEY);

interface PromptRow {
	id: string;
	key: string;
}

interface VersionRow {
	id: string;
	promptId: string;
	version: number;
	content: string;
}

interface BindingRow {
	id: string;
	targetKey: string;
	promptVersionId: string;
}

/**
 * An in-memory stand-in for the three lookups `PublishingPromptSyncDb`
 * declares. Each `seed*` helper below pushes rows into these arrays; the
 * `db` object never does anything smarter than a `.find()` over them, which
 * is enough to exercise every branch in `resolveBoundVersion` without a real
 * query engine.
 *
 * `findDefaultSystemAgentBinding` deliberately takes only the target key, the
 * way the runtime's SYSTEM tier does — a fake that also filtered on a version
 * id could not express the state this suite most needs to cover, a binding
 * that has moved off v1.
 */
function createFixtures() {
	const prompts: PromptRow[] = [];
	const versions: VersionRow[] = [];
	const bindings: BindingRow[] = [];
	let nextId = 0;
	const id = (prefix: string) => `${prefix}-${nextId++}`;

	const db: PublishingPromptSyncDb = {
		findDefaultSystemAgentBinding: async (targetKey) =>
			bindings.find((b) => b.targetKey === targetKey) ?? null,
		findPromptVersionById: async (promptVersionId) =>
			versions.find((v) => v.id === promptVersionId) ?? null,
		systemPromptRowExists: async (key) =>
			prompts.some((p) => p.key === key),
	};

	return {
		db,
		/**
		 * Seed a full row: prompt + a version at `version` (default 1, the
		 * seed's own) + the default binding pointing at it.
		 */
		seedFullRow(key: string, content: string, version = 1): void {
			const promptId = id("prompt");
			prompts.push({ id: promptId, key });
			const versionId = id("version");
			versions.push({ id: versionId, promptId, version, content });
			bindings.push({
				id: id("binding"),
				targetKey: key,
				promptVersionId: versionId,
			});
		},
		/** Seed the prompt row only — no version, no binding. */
		seedPromptRowOnly(key: string): void {
			prompts.push({ id: id("prompt"), key });
		},
		/** Seed the prompt row and a v1 version, but no binding to it. */
		seedRowAndVersionOnly(key: string, content: string): void {
			const promptId = id("prompt");
			prompts.push({ id: promptId, key });
			versions.push({
				id: id("version"),
				promptId,
				version: 1,
				content,
			});
		},
		/**
		 * Seed a default binding whose `promptVersionId` names no version row.
		 * The state a binding-first resolution has to check for rather than
		 * assume away.
		 */
		seedBindingWithDanglingVersion(key: string): void {
			prompts.push({ id: id("prompt"), key });
			bindings.push({
				id: id("binding"),
				targetKey: key,
				promptVersionId: "version-that-is-not-there",
			});
		},
	};
}

describe("checkPublishingPromptSync", () => {
	let fixtures: ReturnType<typeof createFixtures>;

	beforeEach(() => {
		fixtures = createFixtures();
	});

	it("checks every publishing_topic_* prompt key the seed registers, not just the ones a slice touched", async () => {
		// Sync-migration keys plus existence-only ones. All of them are seeded
		// with the IDENTICAL binding shape — `documentTypes: ["GENERAL"],
		// storyKind: null, targetKey` — which is exactly the tuple
		// `findDefaultSystemAgentBinding` resolves, so every one of them can
		// land in the silent state this script exists to detect. Covering a
		// subset while printing a suite-wide PASS is the failure mode of an
		// instrument, not of the code it watches.
		//
		// The expectation is DERIVED from the seed on disk, not typed here —
		// see `seededPublishingKeys` for why a hand-written copy could not
		// support the family-completeness claim the script's header makes. A
		// content type that reaches the seed without reaching `CHECKS` reddens
		// this case by the act of being seeded.
		const report = await checkPublishingPromptSync(fixtures.db);

		expect(
			report.map((r) => r.key).sort(),
			"the keys this script checks and the publishing_topic_* keys the seed writes have diverged - the script's PASS no longer covers the family an operator will read it as covering",
		).toEqual(SEEDED_PUBLISHING_KEYS);
	});

	it("guards each chained key on the NOT LIKE fragment of the NEWEST sync migration on disk", () => {
		// The rule `staleGuardText`'s docblock states, asserted instead of
		// described. Both recurrence paths differ, and only one was covered
		// before this case existed:
		//
		//  - an author REGRESSES a guard to the previous slice's fragment ->
		//    the two STALE cases below go red. Already caught.
		//  - a later slice ADDS a sync migration and opens neither this file
		//    nor the script -> the script keeps the old fragment, the fixtures
		//    keep the old fragment, they agree with each other, every case
		//    passes, and the post-deploy checker reports OK on an environment
		//    the new migration never reached. NOT caught — and it is the path
		//    slices 2D-1 and 2D-2 both took, because an un-moved guard keeps
		//    matching forever: all five chain guards, superseded ones
		//    included, are present verbatim in today's prompt bodies.
		//
		// Reading the authority off disk closes the second path: adding a sync
		// migration moves what this case expects, with nobody remembering to.
		//
		// Scope, stated rather than assumed: "on disk" here means what
		// `discoverSyncPromptChainFolders` finds, and that is a FOLDER-NAME
		// pattern of two prefixes. A prompt-sync migration named outside them
		// is invisible to this case, which would then compare two unchanged
		// lists and pass. That hole is closed from the other end, by the chain
		// suite's "discovers every migration whose statement targets a
		// publishing_topic_* prompt" — a scan of every migration's SQL, so a
		// conventionally-named one that discovery misses is red there.
		const guarded = CHECKS.filter(
			(check) => check.staleGuardText !== undefined,
		);

		// Floor, so the two assertions below cannot both pass vacuously on an
		// empty `CHECKS` or an empty discovery. It only ever grows.
		expect(guarded.length).toBeGreaterThanOrEqual(2);

		// Both directions. A chain on disk with no guarded entry is a key
		// whose freshness nothing asks about; a guarded entry with no chain on
		// disk is a guard no migration defines.
		expect(
			guarded.map((check) => check.key).sort(),
			"the keys CHECKS guards on freshness and the keys with a sync-migration chain on disk have diverged",
		).toEqual([...CHAIN_LAST_FOLDER_BY_KEY.keys()].sort());

		for (const [key, folder] of CHAIN_LAST_FOLDER_BY_KEY) {
			const guard = readSyncMigrationGuard(
				readSyncMigrationSql(MIGRATIONS_DIR, folder),
				folder,
			);
			expect(
				guarded.find((check) => check.key === key)?.staleGuardText,
				`'${key}' is guarded on a fragment that is not the NOT LIKE guard of ${folder}, the newest sync migration in its chain - the checker will report OK on an environment that migration never reached`,
			).toBe(guard);
		}
	});

	it("reports a key whose prompt row is missing entirely", async () => {
		// givenNoPromptRow(WEBINAR_SCRIPT_KEY): nothing seeded for it at all.
		const report = await checkPublishingPromptSync(fixtures.db);

		expect(report.find((r) => r.key === WEBINAR_SCRIPT_KEY)).toEqual({
			key: WEBINAR_SCRIPT_KEY,
			status: "MISSING",
			detail:
				"no SYSTEM prompt row and no default SYSTEM AGENT binding - the seed has " +
				"not run in this environment; generation silently falls back to the " +
				"built-in body, and the org cannot edit it",
		});
	});

	it("reports a Newsletter Blurb key whose prompt row is missing entirely", async () => {
		// Nothing seeded for it at all — the state an environment the seed has
		// never reached is in, which for this key is the whole question.
		const report = await checkPublishingPromptSync(fixtures.db);

		expect(report.find((r) => r.key === NEWSLETTER_BLURB_KEY)?.status).toBe(
			"MISSING",
		);
	});

	it("reports OK when the Newsletter Blurb row, isDefault v1 version and SYSTEM binding all exist", async () => {
		fixtures.seedFullRow(
			NEWSLETTER_BLURB_KEY,
			"the seeded newsletter blurb body",
		);

		const report = await checkPublishingPromptSync(fixtures.db);

		expect(report.find((r) => r.key === NEWSLETTER_BLURB_KEY)?.status).toBe(
			"OK",
		);
	});

	it("reports STALE for a sync-migration key whose body carries none of the chain's text", async () => {
		// Deliberately an arbitrary body rather than a real one: this is the
		// degenerate end of staleness, an environment from before the whole
		// chain. The exact-predecessor case further down is the one that binds
		// to disk, and the two are not interchangeable — see this file's
		// header on what an abbreviated fixture forgets.
		const staleBody =
			"A webinar or demo script is a live presentation, not a written piece.";
		fixtures.seedFullRow(PLANNING_ANALYSIS_KEY, staleBody);

		const report = await checkPublishingPromptSync(fixtures.db);

		expect(
			report.find((r) => r.key === PLANNING_ANALYSIS_KEY)?.status,
		).toBe("STALE");
	});

	it("reports OK when row, isDefault v1 version and SYSTEM binding all exist", async () => {
		fixtures.seedFullRow(
			WEBINAR_SCRIPT_KEY,
			"the seeded webinar script body",
		);

		const report = await checkPublishingPromptSync(fixtures.db);

		expect(report.find((r) => r.key === WEBINAR_SCRIPT_KEY)?.status).toBe(
			"OK",
		);
	});

	it("reports OK for a topic-suggestion body that is the real post-migration body", async () => {
		fixtures.seedFullRow(
			TOPIC_SUGGESTION_KEY,
			TOPIC_SUGGESTION_BODIES.after,
		);

		const report = await checkPublishingPromptSync(fixtures.db);

		expect(report.find((r) => r.key === TOPIC_SUGGESTION_KEY)?.status).toBe(
			"OK",
		);
	});

	// The four cases below are the ones that were MEASURED false-green before
	// this slice fixed the two guard VALUES, now re-seeded on the real bodies
	// so they also catch a guard that matches BOTH sides.
	//
	// Each key's `staleGuardText` used to hold the fragment of the PREVIOUS
	// slice's sync migration, and that fragment survives verbatim in the
	// current prompt body — so a body that stopped at the previous slice
	// carried it, matched, and the script reported OK on an environment this
	// slice's migration had never reached. `checkPublishingPromptSync` allows
	// exactly one guard string per key and returns OK the moment it is
	// present, so there was no second condition left to catch it.
	//
	// The stale body is the migration's own `$old_types$` fragment and the
	// fresh one its `$new_types$` — the complete states either side of the
	// statement, not sentences written around the guard. That is what makes
	// the pair able to fail: a guard string occurring in BOTH bodies (the
	// measured example is `"rather than"`, which the real pre-migration
	// topic-suggestion body contains) reddens the STALE case here, where an
	// abbreviated fixture would have stayed green and certified it.

	it("reports STALE for a topic-suggestion body that stopped at the previous slice's migration", async () => {
		fixtures.seedFullRow(
			TOPIC_SUGGESTION_KEY,
			TOPIC_SUGGESTION_BODIES.before,
		);

		const report = await checkPublishingPromptSync(fixtures.db);

		expect(report.find((r) => r.key === TOPIC_SUGGESTION_KEY)?.status).toBe(
			"STALE",
		);
	});

	it("reports STALE for a planning-analysis body that stopped at the previous slice's migration", async () => {
		fixtures.seedFullRow(
			PLANNING_ANALYSIS_KEY,
			PLANNING_ANALYSIS_BODIES.before,
		);

		const report = await checkPublishingPromptSync(fixtures.db);

		expect(
			report.find((r) => r.key === PLANNING_ANALYSIS_KEY)?.status,
		).toBe("STALE");
	});

	it("reports OK for a planning-analysis body that is the real post-migration body", async () => {
		// The positive half of the pair, and NOT for the reason an earlier
		// comment here claimed. Deleting a `staleGuardText` does not turn the
		// STALE cases green: it makes the key existence-only, and an
		// existence-only key returns OK for any body at any version, so an
		// `expect(...).toBe("STALE")` against OK is red. Deletion is already
		// covered.
		//
		// Nor is this the only thing that sees a guard typo'd, trimmed or
		// re-wrapped: the binding case above asserts `staleGuardText`
		// `.toBe(guard)` against the string read off the migration on disk, so
		// ANY guard that is not byte-equal to it reddens there first, with a
		// message naming the folder. A comment claiming otherwise is what
		// invites the retirement of a case that is in fact load-bearing, which
		// is the condition this file spent a round removing.
		//
		// What this case adds is the CONSEQUENCE, in the checker's own output.
		// A guard that occurs in no body reports STALE for a body that is
		// byte-for-byte the migration's own `$new_types$` — so every
		// environment goes permanently RED, and nobody sees it, because this
		// script runs post-deploy with nothing watching. A permanently red
		// check is how a check gets wired into a pipeline and then suppressed,
		// which is the argument the script's own header makes about
		// `CUSTOMIZED`. The binding case says the guard disagrees with the
		// migration; this one says what the operator would be shown.
		fixtures.seedFullRow(
			PLANNING_ANALYSIS_KEY,
			PLANNING_ANALYSIS_BODIES.after,
		);

		const report = await checkPublishingPromptSync(fixtures.db);

		expect(
			report.find((r) => r.key === PLANNING_ANALYSIS_KEY)?.status,
		).toBe("OK");
	});

	it("distinguishes a half-run seed from one that never ran at all", async () => {
		// Both are MISSING, but the remedies differ and the detail is the only
		// thing that says which: a bare "does a prompt row exist" pass would
		// call this OK and miss that nothing is bound.
		fixtures.seedPromptRowOnly(WEBINAR_SCRIPT_KEY);

		const report = await checkPublishingPromptSync(fixtures.db);

		const row = report.find((r) => r.key === WEBINAR_SCRIPT_KEY);
		expect(row?.status).toBe("MISSING");
		expect(row?.detail).toContain("a SYSTEM prompt row exists");
		expect(row?.detail).not.toContain("the seed has not run");
	});

	it("reports MISSING (not OK) when a version exists but no default binding points at it", async () => {
		// A version row nothing binds is text nobody runs: generation resolves
		// no SYSTEM binding and falls back to the built-in body, which is the
		// silent state this script exists to detect.
		fixtures.seedRowAndVersionOnly(
			WEBINAR_SCRIPT_KEY,
			"the seeded webinar script body",
		);

		const report = await checkPublishingPromptSync(fixtures.db);

		expect(report.find((r) => r.key === WEBINAR_SCRIPT_KEY)?.status).toBe(
			"MISSING",
		);
	});

	it("reports MISSING when the default binding names a version row that is not there", async () => {
		// The family-wide gap this guards against: a binding that resolves to
		// nothing still "exists" as a row, so checking binding existence alone
		// is not the same as checking that the chain resolves. Resolving from
		// the binding end makes this the ONLY thing standing between a
		// dangling foreign key and a reported OK.
		fixtures.seedBindingWithDanglingVersion(WEBINAR_SCRIPT_KEY);

		const report = await checkPublishingPromptSync(fixtures.db);

		expect(report.find((r) => r.key === WEBINAR_SCRIPT_KEY)?.status).toBe(
			"MISSING",
		);
	});

	it("reports CUSTOMIZED, not MISSING, for a sync-migration key bound past v1", async () => {
		// The state this file was rewritten for. `createPromptVersion`
		// repoints a prompt's same-scope bindings at each new version, so an
		// admin who edits a SYSTEM prompt leaves the binding on v2. That is
		// healthy — the sync migration's own `NOT EXISTS (version > 1)` guard
		// exists precisely to decline a prompt somebody has edited — and it
		// must not be reported as an absent seed or an undelivered migration.
		//
		// This body carries no guard fragment, so this case also reddens if
		// the version check is reordered after the text check. That is
		// incidental to what it is named for, and it is not what the ordering
		// rests on: the case below pins the ordering deliberately.
		fixtures.seedFullRow(
			PLANNING_ANALYSIS_KEY,
			"a body an admin wrote by hand, with none of the shipped wording",
			2,
		);

		const report = await checkPublishingPromptSync(fixtures.db);

		const row = report.find((r) => r.key === PLANNING_ANALYSIS_KEY);
		expect(row?.status).toBe("CUSTOMIZED");
		expect(row?.detail).toContain("v2");
	});

	it("checks the version BEFORE the text: an edited prompt on a pre-migration body is CUSTOMIZED, not STALE", async () => {
		// A real ordering control, which its previous form was not. That form
		// seeded a body carrying the CURRENT guard, so under the reordering it
		// meant to forbid — the `version > 1` block moved below the stale
		// check — the text check simply passed and the relocated version check
		// still returned CUSTOMIZED. Green either way; it could not detect the
		// thing it was named for.
		//
		// A v2 body WITHOUT the current guard can. Version-first it is
		// CUSTOMIZED; text-first it is STALE, and the case fires.
		//
		// MEASURED, and it corrects a claim worth not repeating: performing
		// that reordering against the suite as it stood reddened exactly ONE
		// case, "reports CUSTOMIZED, not MISSING, for a sync-migration key
		// bound past v1" — so the ordering was already pinned, incidentally,
		// by a case named for something else and only because its body happens
		// to carry no guard. This case pins it on purpose and on a real body,
		// so an edit to that one's fixture cannot silently unpin it.
		fixtures.seedFullRow(
			TOPIC_SUGGESTION_KEY,
			TOPIC_SUGGESTION_BODIES.before,
			2,
		);

		const report = await checkPublishingPromptSync(fixtures.db);

		expect(report.find((r) => r.key === TOPIC_SUGGESTION_KEY)?.status).toBe(
			"CUSTOMIZED",
		);
	});

	it("reports OK for an EXISTENCE-only key bound past v1", async () => {
		// The asymmetry is deliberate. For a key no migration targets there is
		// no freshness question to be exempt from, so an edited prompt is
		// simply a bound prompt: the seed ran, the org can edit it, and it
		// did. CUSTOMIZED here would report an exemption from a check that was
		// never applied.
		fixtures.seedFullRow(
			WEBINAR_SCRIPT_KEY,
			"an edited webinar script body",
			3,
		);

		const report = await checkPublishingPromptSync(fixtures.db);

		const row = report.find((r) => r.key === WEBINAR_SCRIPT_KEY);
		expect(row?.status).toBe("OK");
		expect(row?.detail).toContain("v3");
	});

	it("resolves the bound row when a second, unbound SYSTEM prompt row shares the key", async () => {
		// `prompt`'s unique key is NULL-distinct in Postgres, so two SYSTEM
		// rows for one key coexist legally. A resolution that started by
		// picking a prompt row could pick the unbound one and report a healthy
		// environment as broken; starting from the binding has nothing to pick
		// between, because `prompt_binding`'s key is NULLS NOT DISTINCT.
		fixtures.seedPromptRowOnly(TOPIC_SUGGESTION_KEY);
		fixtures.seedFullRow(
			TOPIC_SUGGESTION_KEY,
			TOPIC_SUGGESTION_BODIES.after,
		);

		const report = await checkPublishingPromptSync(fixtures.db);

		expect(report.find((r) => r.key === TOPIC_SUGGESTION_KEY)?.status).toBe(
			"OK",
		);
	});
});
