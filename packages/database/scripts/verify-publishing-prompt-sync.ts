#!/usr/bin/env npx tsx

/**
 * Post-deploy verification for the Publishing Suite's editable prompts
 * (Fizzy #1988, Publishing Suite Phase 2D).
 *
 * # Why this exists
 *
 * Nothing in this repository's CI runs `seed-prompts-only.ts` against a
 * deployed environment, and a missing SYSTEM prompt row does not fail
 * generation — the resolver simply finds no binding and falls back to the
 * hard-coded body in `@repo/utils`. The feature keeps working, the Prompt
 * Library shows no entry for it, and nothing anywhere reports that the org
 * can no longer edit the prompt it thinks it can edit. This script is the
 * detector for that silent state, run by hand (or wired into a pipeline
 * later, via its non-zero exit) against a specific environment.
 *
 * # The nine keys, and the two different questions they ask
 *
 * `CHECKS` below covers all NINE `publishing_topic_*` prompt keys
 * `seed-prompts-only.ts` registers, split into two kinds. The split is about
 * which QUESTION a key can be asked, not about which keys matter: every one of
 * the nine is seeded with the identical binding shape
 * (`documentTypes: ["GENERAL"], storyKind: null, targetKey`), which is exactly
 * the tuple `findDefaultSystemAgentBinding` resolves, so every one of them can
 * land in the silent state the section above describes.
 *
 *  - FRESHNESS — `publishing_topic_planning_analysis` and
 *    `publishing_topic_suggestion`. These two predate Phase 2D and are
 *    rewritten in place by a CHAIN of `sync_*` migrations, one per
 *    content-type slice, because `seed-prompts-only.ts` is INSERT-ONLY and
 *    never reaches a prompt that already exists. So there is a second question
 *    to ask of them: did the newest such migration's text reach this
 *    environment's live version? Each carries a `staleGuardText` for that, and
 *    it must track the NEWEST migration in its chain — see the field's own
 *    docblock, which records the false green that rule exists to stop, and
 *    `verify-publishing-prompt-sync.test.ts`, which asserts the rule against
 *    the migrations on disk rather than restating it.
 *  - EXISTENCE — the other seven: `publishing_topic_short_post`,
 *    `publishing_topic_linkedin_post`, `publishing_topic_blog_post`,
 *    `publishing_topic_case_study`, `publishing_topic_stakeholder_email`,
 *    `publishing_topic_webinar_script` (2D-1) and
 *    `publishing_topic_newsletter_blurb` (2D-2). No migration targets any of
 *    them TODAY — the seed's own INSERT is the only writer they have had so
 *    far, so there is no earlier body for them to be behind on and no freshness
 *    question to ask. For these the whole question is EXISTENCE: did the seed
 *    run here at all, leaving behind a default binding that resolves to a real
 *    version an org can actually edit?
 *
 *    That "today" is load-bearing. The seed is INSERT-ONLY, so the day one of
 *    these seven bodies is reworded, the change can ONLY reach a deployed
 *    environment as a migration — the same pressure that produced five links
 *    across the two chains above — and the key moves into the first kind, with
 *    a `staleGuardText` here in the same change. The migration must also be
 *    named so the suites discover it; a conventionally-shaped one that is not
 *    reddens the chain suite's SQL-wide scan rather than passing unnoticed.
 *
 * A key is in the second kind because no `sync_*` migration targets it, never
 * because nobody got round to it — the two lists together are every
 * `publishing_topic_*` key the seed writes, so a PASS here means what an
 * operator will read it as meaning. That last clause is asserted, not assumed:
 * `verify-publishing-prompt-sync.test.ts` derives the family from
 * `seed-prompts-only.ts` on disk and fails if `CHECKS` and the seed disagree,
 * so a tenth content type cannot leave this list at nine.
 *
 * A new content type adds one `{ key: ... }` entry of the second kind. What
 * it does NOT do is leave the first kind alone: if the slice also ships a
 * `sync_*` migration for either chained key — 2D-1 and 2D-2 both did — that
 * key's `staleGuardText` moves forward in the same change, or this script
 * goes on reporting OK for a migration that never arrived. That is no longer
 * left to whoever remembers to open this file: the test suite reads the
 * newest migration in each chain off disk and fails if a guard here disagrees
 * with it.
 *
 * # Why resolution starts at the BINDING, not at a version number
 *
 * The runtime's SYSTEM tier (`getBoundPromptVersion`) asks one question: is
 * there a default SYSTEM binding for this target, and what version does it
 * reference? It never names a version number. This script asks the same
 * question in the same order, and reads the version the binding points at.
 *
 * Starting from an assumed v1 and checking whether the binding agreed would
 * be a different question, and it produces two false alarms:
 *
 *  - `createPromptVersion` REPOINTS a prompt's same-scope bindings at each new
 *    version, so an admin who edits a SYSTEM prompt in the Prompt Library
 *    leaves the binding on v2 and nothing on v1. Generation resolves that v2
 *    binding perfectly well; a v1-anchored check would report the environment
 *    as unbound and send whoever ran it looking for a seed that did run.
 *  - `prompt`'s unique key is `(key, scope, userId, organizationId)` and
 *    Postgres treats NULL as distinct in a plain unique index, so two SYSTEM
 *    rows for one key (both nulling `userId` and `organizationId`) coexist
 *    legally. A `findFirst` by key can return the unbound one while the bound
 *    one is healthy. `prompt_binding`'s key, by contrast, is
 *    `NULLS NOT DISTINCT` (see
 *    `20260903100000_prompt_binding_unique_nulls_not_distinct`), so at most
 *    one row holds the SYSTEM AGENT tuple — resolving from that end has no
 *    duplicate to pick between.
 *
 * The binding tuple is the one every sync migration's own `WHERE` clause
 * targets: SYSTEM scope, the agent key, `targetType = 'AGENT'`,
 * `documentType = 'GENERAL'`, `storyKind IS NULL`, `isDefault = true`.
 *
 * The version row is still fetched separately rather than trusted from the
 * binding alone: a `promptVersionId` pointing at a row that is not actually
 * there is a known gap elsewhere in how this system resolves bound prompts,
 * and reporting a binding's mere existence as health would repeat it here.
 *
 * # Why a customised prompt is its own reported state
 *
 * For the two `sync_*` keys, a binding on a version above 1 means the
 * migration DECLINED to touch this environment's prompt — which is what its
 * `NOT EXISTS (version > 1)` guard exists to do. That is a healthy outcome,
 * not staleness: the environment is running text somebody deliberately wrote,
 * and "did the migration's paragraph reach the live body" is not a question
 * that applies to it. Reporting it as `MISSING` or `STALE` would train an
 * operator to ignore this script; folding it into a bare `OK` would hide that
 * the shipped paragraph is not what runs here. So it gets `CUSTOMIZED`, and
 * it does NOT fail the run — see `main()` for that reasoning.
 *
 * Run with:
 *   pnpm --filter @repo/database verify:publishing-prompt-sync            # local
 *   pnpm --filter @repo/database verify:publishing-prompt-sync:staging    # staging
 *   pnpm --filter @repo/database verify:publishing-prompt-sync:prod       # production
 */

import { PUBLISHING_BLOG_POST_AGENT_KEY } from "@repo/utils/publishing-blog-post-prompt";
import { PUBLISHING_CASE_STUDY_AGENT_KEY } from "@repo/utils/publishing-case-study-prompt";
import { PUBLISHING_LINKEDIN_POST_AGENT_KEY } from "@repo/utils/publishing-linkedin-post-prompt";
import { PUBLISHING_NEWSLETTER_BLURB_AGENT_KEY } from "@repo/utils/publishing-newsletter-blurb-prompt";
import { PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY } from "@repo/utils/publishing-planning-prompt";
import { PUBLISHING_SHORT_POST_AGENT_KEY } from "@repo/utils/publishing-short-post-prompt";
import { PUBLISHING_STAKEHOLDER_EMAIL_AGENT_KEY } from "@repo/utils/publishing-stakeholder-email-prompt";
import { PUBLISHING_TOPIC_SUGGESTION_AGENT_KEY } from "@repo/utils/publishing-suggestion-prompt";
import { PUBLISHING_WEBINAR_SCRIPT_AGENT_KEY } from "@repo/utils/publishing-webinar-script-prompt";
// Type-only: erased at compile time, so importing it here does not pull in
// the real Prisma client (that stays deferred to `main()`, below). It exists
// so `createPrismaPromptSyncDb`'s parameter is checked against the actual
// generated model types rather than a hand-typed stand-in.
import type { Prisma } from "../prisma/generated/client";
import { isDirectRun } from "../prisma/lib/is-direct-run";

/**
 * The database access this checker needs, as three plain lookups rather than
 * the shape of any particular query client. `main()` below is the only thing
 * that adapts a real database connection onto this interface, which is what
 * keeps `checkPublishingPromptSync` testable against an in-memory fake with
 * no live Postgres and no generated Prisma types in the test file at all.
 */
export interface PublishingPromptSyncDb {
	/**
	 * The default SYSTEM AGENT binding for `targetKey`, and the version it
	 * references — the runtime's own SYSTEM-tier question. Returns the
	 * referenced id rather than the version row, so the caller can prove the
	 * row is really there instead of inferring it from a foreign key.
	 */
	findDefaultSystemAgentBinding(
		targetKey: string,
	): Promise<{ id: string; promptVersionId: string } | null>;
	/**
	 * The version row a binding references, by id. `version` comes back so a
	 * caller can tell a pristine seed (v1) from a prompt someone has edited.
	 */
	findPromptVersionById(
		promptVersionId: string,
	): Promise<{ id: string; version: number; content: string } | null>;
	/**
	 * Whether ANY SYSTEM prompt row carries this key. Only reached once the
	 * binding lookup has already come back empty, to tell "the seed never ran
	 * here" apart from "the seed ran but left nothing bound" — two states with
	 * different remedies. Never used to resolve content.
	 */
	systemPromptRowExists(key: string): Promise<boolean>;
}

export type PublishingPromptSyncStatus =
	| "OK"
	| "STALE"
	| "MISSING"
	| "CUSTOMIZED";

export interface PublishingPromptSyncResult {
	key: string;
	status: PublishingPromptSyncStatus;
	detail: string;
}

const NO_ROW_DETAIL =
	"no SYSTEM prompt row and no default SYSTEM AGENT binding - the seed has " +
	"not run in this environment; generation silently falls back to the " +
	"built-in body, and the org cannot edit it";

const UNBOUND_DETAIL =
	"a SYSTEM prompt row exists but no default SYSTEM AGENT binding points at " +
	"any version of it - generation silently falls back to the built-in body";

const DANGLING_VERSION_DETAIL =
	"the default SYSTEM AGENT binding references a prompt version row that is " +
	"not there - generation silently falls back to the built-in body";

export interface PromptSyncCheck {
	key: string;
	/**
	 * Present only for a key a `sync_*` migration is expected to have
	 * rewritten in place: a clause unique to the paragraph that migration
	 * adds, copied verbatim from its own `NOT LIKE` idempotency guard so
	 * this check and the migration read a live body the same way. Absent
	 * means "brand-new key with no earlier body to be behind on" — existence
	 * is the whole question for it.
	 *
	 * # The rule: this tracks the NEWEST migration in the key's chain
	 *
	 * It must be the guard of the LATEST `sync_*` migration targeting this
	 * key — not the one that first introduced a value here. Every slice that
	 * adds a sync migration for a key moves this string forward in the same
	 * change, and a slice that does not silently disables the check.
	 *
	 * That is not a style preference; it was measured. Each of the two
	 * entries below once held the guard of the PREVIOUS slice's migration,
	 * and an earlier fragment survives verbatim in the body a later migration
	 * produces — it is a different paragraph. So the superseded string was
	 * still present, `checkPublishingPromptSync` allows exactly one guard per
	 * key and returns OK the moment it is found, and both keys reported OK
	 * whether or not the current slice's migration had ever reached the
	 * environment. Two slices inherited that state because both comments read
	 * as provenance — "from migration X" is true forever and says nothing
	 * about whether X is still the newest.
	 *
	 * The newest fragment is strictly stronger than an older one, never
	 * merely different: migrations apply in order and each carries its own
	 * `NOT EXISTS (version > 1)` customisation guard, so the newest clause
	 * being present implies every earlier one landed.
	 */
	staleGuardText?: string;
}

/**
 * Every `publishing_topic_*` prompt key, and how each one is checked.
 *
 * Exported so `verify-publishing-prompt-sync.test.ts` can assert the
 * `staleGuardText` rule against the migrations on disk instead of restating it
 * in prose. That binding is the reason this is exported at all: a guard left
 * behind by a later slice is invisible to every case that seeds its own
 * fixtures, because the fixture and the guard are edited by the same hand and
 * agree with each other while both disagree with the environment.
 */
export const CHECKS: readonly PromptSyncCheck[] = [
	{
		key: PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY,
		// The `NOT LIKE` guard of the NEWEST sync migration for this key,
		// 20260910140000_sync_planning_analysis_newsletter_blurb_content_type
		// (migration.sql:135). A later slice that adds another one moves this
		// forward — and does not have to remember to, because the test suite
		// reads the newest migration in this chain off disk and fails if this
		// string is not its guard. See `staleGuardText` above for why.
		staleGuardText: "goes out inside a newsletter someone already sends",
	},
	{
		key: PUBLISHING_TOPIC_SUGGESTION_AGENT_KEY,
		// The `NOT LIKE` guard of the NEWEST sync migration for this key,
		// 20260910150000_sync_topic_suggestion_newsletter_blurb_type
		// (migration.sql:113). Same binding to disk as the entry above.
		staleGuardText: "borrows a distribution list that already exists",
	},
	// The existence-only keys: every other `publishing_topic_*` key the seed
	// registers. No `sync_*` migration targets any of them, so the seed's own
	// INSERT is the only writer they could have and there is no freshness
	// question to ask — add the next brand-new content type the same way, with
	// no `staleGuardText`. They carry no logic of their own; what they buy is
	// that this script's PASS covers the whole family an operator will read it
	// as covering, rather than the subset one slice happened to touch.
	{ key: PUBLISHING_SHORT_POST_AGENT_KEY },
	{ key: PUBLISHING_LINKEDIN_POST_AGENT_KEY },
	{ key: PUBLISHING_BLOG_POST_AGENT_KEY },
	{ key: PUBLISHING_CASE_STUDY_AGENT_KEY },
	{ key: PUBLISHING_STAKEHOLDER_EMAIL_AGENT_KEY },
	{ key: PUBLISHING_WEBINAR_SCRIPT_AGENT_KEY },
	{ key: PUBLISHING_NEWSLETTER_BLURB_AGENT_KEY },
];

/**
 * Resolve what a runtime lookup would actually run for `key`: the default
 * SYSTEM AGENT binding, then the version row it references — see the header
 * for why this starts at the binding and not at a version number.
 */
async function resolveBoundVersion(
	db: PublishingPromptSyncDb,
	key: string,
): Promise<
	| { found: true; version: number; content: string }
	| { found: false; detail: string }
> {
	const binding = await db.findDefaultSystemAgentBinding(key);
	if (!binding) {
		// Nothing is bound. Which of the two remedies applies depends on
		// whether the prompt row is there at all, so ask — this is the only
		// thing the prompt-row lookup is for.
		const rowExists = await db.systemPromptRowExists(key);
		return {
			found: false,
			detail: rowExists ? UNBOUND_DETAIL : NO_ROW_DETAIL,
		};
	}

	const version = await db.findPromptVersionById(binding.promptVersionId);
	if (!version) {
		return { found: false, detail: DANGLING_VERSION_DETAIL };
	}

	return { found: true, version: version.version, content: version.content };
}

/**
 * Check every Publishing Suite prompt key in `CHECKS`, against `db`.
 *
 * Exported so the resolution logic is testable against an in-memory fake,
 * independent of the CLI wrapper below (`main`) — the only thing here that
 * ever touches a real database.
 */
export async function checkPublishingPromptSync(
	db: PublishingPromptSyncDb,
): Promise<PublishingPromptSyncResult[]> {
	const results: PublishingPromptSyncResult[] = [];

	for (const check of CHECKS) {
		const resolved = await resolveBoundVersion(db, check.key);

		if (!resolved.found) {
			results.push({
				key: check.key,
				status: "MISSING",
				detail: resolved.detail,
			});
			continue;
		}

		if (check.staleGuardText === undefined) {
			results.push({
				key: check.key,
				status: "OK",
				detail: `default SYSTEM AGENT binding resolves to v${resolved.version} of this prompt`,
			});
			continue;
		}

		if (resolved.version > 1) {
			// Freshness does not apply: this environment is running its own
			// edited text, which is exactly the case the migration's
			// `NOT EXISTS (version > 1)` guard declines to overwrite.
			results.push({
				key: check.key,
				status: "CUSTOMIZED",
				detail: `bound to v${resolved.version} - this environment runs its own edited prompt, so this key's sync migration correctly left it alone and migration freshness does not apply`,
			});
			continue;
		}

		if (!resolved.content.includes(check.staleGuardText)) {
			results.push({
				key: check.key,
				status: "STALE",
				detail: "live prompt version predates this key's sync migration - the migration has not reached this environment",
			});
			continue;
		}

		results.push({
			key: check.key,
			status: "OK",
			detail: "live prompt version carries the sync migration's text",
		});
	}

	return results;
}

/**
 * Build a `PublishingPromptSyncDb` from a real Prisma client — the only
 * place in this file that ever issues a database query. Takes a
 * `Prisma.TransactionClient` rather than the concrete `PrismaClient` type so
 * it accepts either: the real `db` singleton `main()` passes below (a
 * `PrismaClient` carries every member `TransactionClient` does, plus more,
 * so it satisfies this parameter directly) or a `tx` handed to a
 * `db.$transaction(async (tx) => ...)` callback, which is what
 * `verify-publishing-prompt-sync.integration.test.ts` uses to exercise these
 * queries against real, rolled-back Postgres rows instead of only against the
 * in-memory fake `verify-publishing-prompt-sync.test.ts` exercises the
 * resolution logic with.
 */
export function createPrismaPromptSyncDb(
	client: Prisma.TransactionClient,
): PublishingPromptSyncDb {
	return {
		findDefaultSystemAgentBinding: (targetKey) =>
			client.promptBinding.findFirst({
				// The runtime's SYSTEM tier, field for field, minus the
				// `promptVersionId` this used to pin: the version is an
				// OUTPUT of this lookup, not an input to it.
				where: {
					targetType: "AGENT",
					targetKey,
					documentType: "GENERAL",
					storyKind: null,
					scope: "SYSTEM",
					isDefault: true,
				},
				select: { id: true, promptVersionId: true },
			}),
		findPromptVersionById: (promptVersionId) =>
			client.promptVersion.findUnique({
				where: { id: promptVersionId },
				select: { id: true, version: true, content: true },
			}),
		systemPromptRowExists: async (key) =>
			(await client.prompt.findFirst({
				where: { key, scope: "SYSTEM" },
				select: { id: true },
			})) !== null,
	};
}

async function main(): Promise<void> {
	// Deferred import: loading `../prisma/client` only once a direct run has
	// been confirmed keeps importing this module (as the test file does, to
	// reach `checkPublishingPromptSync`) from going anywhere near a real
	// database connection.
	const { db } = await import("../prisma/client");

	const adapter = createPrismaPromptSyncDb(db);

	console.log(
		"[verify-publishing-prompt-sync] Checking Publishing Suite prompt rows...\n",
	);

	const report = await checkPublishingPromptSync(adapter);

	// CUSTOMIZED does NOT fail the run, and that is a deliberate choice rather
	// than leniency. Every other status names something an operator can act on
	// — run the seed, deploy the migration. There is no action behind
	// CUSTOMIZED: the environment is running text somebody there wrote on
	// purpose, and the only "remedy" would be to overwrite it, which is
	// precisely what the migration's own guard refuses to do. A non-zero exit
	// for a state with no remedy is how a check gets wired into a pipeline and
	// then permanently suppressed. It is still printed, on its own marker and
	// with its own line in the summary, because "the shipped paragraph is not
	// what runs here" is worth knowing even when nothing is wrong.
	let failed = false;
	let customized = 0;
	for (const row of report) {
		const marker =
			row.status === "OK" ? "✓" : row.status === "CUSTOMIZED" ? "•" : "✗";
		console.log(
			`  ${marker}  ${row.key.padEnd(36)}  ${row.status.padEnd(10)}  ${row.detail}`,
		);
		if (row.status === "CUSTOMIZED") {
			customized += 1;
		} else if (row.status !== "OK") {
			failed = true;
		}
	}

	if (failed) {
		console.error(
			"\n✗ FAIL — at least one Publishing Suite prompt key does not resolve to a " +
				"live prompt here, or resolves to one a sync migration has not reached. " +
				"A MISSING row means generation is on the built-in fallback body: read " +
				"its detail for which of the three causes applies, since the remedies " +
				"differ. A STALE one means the key's sync migration has not been " +
				"deployed here yet.",
		);
		process.exit(1);
	}

	if (customized > 0) {
		console.log(
			`\n✓ PASS — every Publishing Suite prompt key this script covers resolves to a bound version. ${customized} of them ` +
				"is running an edited prompt rather than the shipped one, which is a supported state, not a fault: " +
				"its sync migration declines to overwrite a prompt somebody has edited. If the shipped paragraph is " +
				"wanted there, the edit has to be re-made by hand in the Prompt Library.",
		);
		process.exit(0);
	}

	console.log(
		"\n✓ PASS — every Publishing Suite prompt key this script covers is present and current.",
	);
	process.exit(0);
}

if (isDirectRun(import.meta.url)) {
	main().catch((err) => {
		console.error("[verify-publishing-prompt-sync] Unexpected error:", err);
		process.exit(2);
	});
}
