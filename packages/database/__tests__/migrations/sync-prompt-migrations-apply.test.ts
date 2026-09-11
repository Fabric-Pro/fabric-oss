/**
 * The executing half of the Publishing Suite prompt sync migrations
 * (Fizzy #1988, Phase 2D slice 1).
 *
 * `sync-prompt-migration-chains.test.ts` is entirely textual: it reconstructs
 * the body states from the in-repo constant and proves the fragments are
 * internally consistent. Nothing in it can prove the statement finds the right
 * ROW — and a mistargeted irreversible migration that passes CI is the worst
 * outcome available here, because a migration cannot be re-run once its name is
 * in `_prisma_migrations`.
 *
 * So this suite executes the migration's own `UPDATE` — extracted from the
 * migration file, not paraphrased — against a real Postgres.
 *
 * # It seeds its own fixtures, and must
 *
 * `db-integration.yml` runs `prisma migrate deploy` and never runs
 * `seed-prompts-only.ts`. On a fresh CI database there is no prompt /
 * prompt_version / prompt_binding row for either target key at all, so the sync
 * migrations matched zero rows during that apply and the run proves nothing
 * about targeting. Every row this suite reads is one it wrote.
 *
 * # Everything runs inside a transaction that is rolled back
 *
 * The fixtures use the REAL agent keys, because the statement names them as SQL
 * literals and substituting a test key would be testing a paraphrase. On a
 * developer's database the seeded rows for those keys already exist and would
 * be matched by the same statement. Rolling back is what makes running this
 * against a live dev database safe for the DATA — it does not by itself make
 * the suite runnable. See the note below the index this collides with: a
 * database that already carries the prompt seed fails ten of the eleven cases.
 *
 * # Why the declining cases each get their own transaction
 *
 * Measured on Postgres 16, not assumed: `prompt_binding`'s unique index is
 * `("targetType", "targetKey", "documentType", "storyKind", scope, "userId",
 * "organizationId", "projectId") NULLS NOT DISTINCT`. `NULLS NOT DISTINCT` is
 * the part that matters — it means at most ONE binding can hold the tuple this
 * migration targets, so the pristine row, the customised row and the
 * non-default row cannot be arranged side by side and compared in one pass.
 * Each declining case therefore stands its subject up as the SOLE holder of
 * that tuple and asserts the statement matches zero rows — then removes the one
 * thing that declined it and asserts the same statement now matches one. That
 * second half is the negative control: without it, a predicate broken in some
 * unrelated way would report the same clean zero.
 *
 * `prompt`'s own unique index is NULL-distinct by contrast, so several SYSTEM
 * prompt rows may share a key and coexist with a seeded one.
 *
 * This suite needs a database that has run `migrate deploy` but NOT
 * `seed-prompts-only.ts` — CI's database is exactly that. On a database that
 * already carries the prompt seed, `bind()`'s fixture insert collides with the
 * seeded SYSTEM default binding on the unique index above, and ten of the
 * eleven cases fail with a unique-constraint violation. That is a seeded local
 * database being unsuitable for this suite, not a broken suite; rerun it
 * against a `migrate deploy`-only database (or drop the prompt seed rows for
 * the two agent keys above) to get a clean run.
 *
 * # Gate
 *
 * `hasReachableDatabaseUrl()` + `describe.skipIf`, copying
 * `backfill-default-excalidraw.test.ts`. Deliberately NOT the bespoke
 * `RUN_*_MIGRATION_INVARIANT` opt-in that the closer subject-matter sibling
 * `remove-passive-analysis-stage.test.ts` uses: no workflow in this repo sets
 * that variable, so the executing half of that file has never run in CI while
 * looking like a database test. The step added to `db-integration.yml` for this
 * suite fails the job if any case reports as skipped.
 */

import { readdirSync, readFileSync } from "node:fs";
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
import { beforeAll, describe, expect, it } from "vitest";
import {
	type Prisma,
	PublishingTopicPostType,
} from "../../prisma/generated/client";
import { hasReachableDatabaseUrl } from "../_helpers/db-availability";
import {
	chainLastFoldersByAgentKey,
	discoverSyncPromptChainFolders,
} from "../_helpers/sync-prompt-migration-discovery";

const SHOULD_RUN = hasReachableDatabaseUrl();

// Conditional import — the `db` singleton reads DATABASE_URL when the module
// loads, so it is deferred until the runner has decided to run.
let db: typeof import("../../prisma/client").db | undefined;

/** A prompt key no seed writes; used for the wrong-agent control. */
const CONTROL_AGENT_KEY = "sync_migration_fixture_other_agent";

interface SyncCase {
	label: string;
	folderSuffix: string;
	agentKey: string;
	constant: string;
}

const CASES: SyncCase[] = [
	{
		label: "planning & analysis",
		folderSuffix: "_sync_planning_analysis_newsletter_blurb_content_type",
		agentKey: PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY,
		constant: PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY,
	},
	{
		label: "topic suggestion",
		folderSuffix: "_sync_topic_suggestion_newsletter_blurb_type",
		agentKey: PUBLISHING_TOPIC_SUGGESTION_AGENT_KEY,
		constant: PUBLISHING_TOPIC_SUGGESTION_FALLBACK_BODY,
	},
];

/**
 * `CASES` above is a hand-written list, and the chain guard beside this file
 * finds its migrations by discovery. Nothing previously connected the two, so
 * a future prompt-sync migration that landed inside the naming convention got
 * textual replay and no executing coverage — and every case here stayed green
 * while covering nothing new, because the chain guard's own non-empty floors
 * are satisfied by the migrations that already exist.
 *
 * These cases connect them. They assert coverage of each chain's LAST
 * migration rather than of every discovered one, because only the last link
 * can be executed here at all: the fixture body is reconstructed by reversing
 * a migration's substitution against the CURRENT `@repo/utils` constant, which
 * is exact for the last link and a measured no-op for any earlier one (see
 * `chainLastFoldersByAgentKey`). Earlier links are covered by the chain
 * guard's backwards walk, which has no such limit.
 */
describe("every prompt-sync chain's last migration is executed here", () => {
	const lastByAgentKey = chainLastFoldersByAgentKey(migrationsDir());

	it("covers the last migration of every discovered chain", () => {
		for (const [agentKey, folder] of lastByAgentKey) {
			expect(
				CASES.some((c) => folder.endsWith(c.folderSuffix)),
				`${folder} is the last migration of the '${agentKey}' chain and the chain guard replays it, but no case in this file executes it against a real row — add a CASES entry`,
			).toBe(true);
		}
	});

	it("has no CASES entry that names a migration outside a discovered chain", () => {
		// The other direction, and it catches what a throw cannot. A suffix
		// matching NO folder does already throw in `loadMigrationSql` — with
		// or without a database, since `describe.skipIf` still runs its
		// collector callback (measured) — but that throw takes the file down
		// at collection and registers zero tests, so what a reader sees is a
		// stack trace rather than a named expectation. A suffix that matches a
		// REAL folder does not throw at all: point one at an earlier link of
		// a chain and every existing case reconstructs its fixture from a
		// no-op reversal and asserts the opposite of what it claims. That is
		// the state this case exists to name.
		const discovered = discoverSyncPromptChainFolders(migrationsDir());
		for (const testCase of CASES) {
			const matches = discovered.filter((folder) =>
				folder.endsWith(testCase.folderSuffix),
			);
			expect(
				matches.length,
				`${testCase.folderSuffix} matches ${matches.length} discovered migrations; expected exactly one`,
			).toBe(1);
			expect(
				[...lastByAgentKey.values()],
				`${testCase.folderSuffix} is not the last migration of its chain, so its fixture body cannot be reconstructed from the current constant`,
			).toContain(matches[0]);
		}
	});

	it("discovered more than zero chains", () => {
		// Without this, a discovery pattern that stopped matching anything
		// would make both cases above pass by iterating nothing — the same
		// vacuous-green failure the chain guard's own non-empty case exists
		// for.
		expect(lastByAgentKey.size).toBeGreaterThanOrEqual(2);
	});
});

function migrationsDir(): string {
	return join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"prisma",
		"migrations",
	);
}

function loadMigrationSql(folderSuffix: string): string {
	const dir = migrationsDir();
	const folder = readdirSync(dir).find((entry) =>
		entry.endsWith(folderSuffix),
	);
	if (!folder) {
		throw new Error(
			`Could not locate the ${folderSuffix} migration folder`,
		);
	}
	return readFileSync(join(dir, folder, "migration.sql"), "utf8");
}

function extractFragment(sql: string, tag: string): string {
	const delimiter = `$${tag}$`;
	const start = sql.indexOf(delimiter);
	if (start === -1) {
		throw new Error(`Migration has no ${delimiter} fragment`);
	}
	const contentStart = start + delimiter.length;
	const end = sql.indexOf(delimiter, contentStart);
	if (end === -1) {
		throw new Error(`Migration's ${delimiter} fragment is not closed`);
	}
	return sql.slice(contentStart, end);
}

/**
 * The migration's statement, verbatim from its first `UPDATE` line onwards.
 *
 * Anchored on a line start so a header comment containing the word cannot move
 * the cut. The trailing `;` is stripped because `$executeRawUnsafe` takes one
 * statement.
 */
function extractStatement(sql: string): string {
	const match = /^UPDATE\b/m.exec(sql);
	if (!match) {
		throw new Error("Migration has no UPDATE statement");
	}
	return sql.slice(match.index).trim().replace(/;\s*$/, "");
}

/** Thrown to abort the transaction once a case's assertions have run. */
class RollbackSignal extends Error {}

async function inRolledBackTransaction(
	body: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
	if (!db) {
		throw new Error("db is not initialized — beforeAll did not run");
	}
	try {
		await db.$transaction(
			async (tx) => {
				await body(tx);
				throw new RollbackSignal();
			},
			{ maxWait: 15_000, timeout: 60_000 },
		);
	} catch (error) {
		if (!(error instanceof RollbackSignal)) {
			throw error;
		}
	}
}

beforeAll(async () => {
	if (!SHOULD_RUN) {
		return;
	}
	const dbModule = await import("../../prisma/client");
	db = dbModule.db;
});

describe.skipIf(!SHOULD_RUN)(
	"Publishing Suite prompt sync migrations — applied to real rows",
	() => {
		for (const testCase of CASES) {
			const sql = loadMigrationSql(testCase.folderSuffix);
			const statement = extractStatement(sql);
			const replaced = extractFragment(sql, "old_types");
			const replacement = extractFragment(sql, "new_types");
			// The body a deployed row is still carrying: the constant with this
			// migration's substitution reversed. Reconstructed rather than
			// hand-copied, for the reason the chain guard reconstructs it — a
			// hand-copied "before" is a third copy of the paragraph that
			// nothing keeps in step.
			const bBefore = testCase.constant.replaceAll(replacement, replaced);

			describe(testCase.label, () => {
				/**
				 * A SYSTEM prompt carrying the pre-migration body, with
				 * `versions` versions; returns the v1 row's id.
				 */
				async function makePrompt(
					tx: Prisma.TransactionClient,
					scope: "SYSTEM" | "ORG",
					key: string,
					versions: number,
				): Promise<string> {
					const prompt = await tx.prompt.create({
						data: {
							key,
							name: `fixture ${key}`,
							scope,
							createdBy: "sync-migration-fixture",
						},
					});
					const first = await tx.promptVersion.create({
						data: {
							promptId: prompt.id,
							version: 1,
							content: bBefore,
							createdBy: "sync-migration-fixture",
							scope,
						},
					});
					for (let v = 2; v <= versions; v++) {
						await tx.promptVersion.create({
							data: {
								promptId: prompt.id,
								version: v,
								content: `${bBefore}\n\nAn edit this organization made.`,
								createdBy: "sync-migration-fixture",
								scope,
							},
						});
					}
					return first.id;
				}

				async function bind(
					tx: Prisma.TransactionClient,
					promptVersionId: string,
					overrides: {
						targetKey?: string;
						scope?: "SYSTEM" | "ORG";
						isDefault?: boolean;
					} = {},
				): Promise<string> {
					const binding = await tx.promptBinding.create({
						data: {
							targetType: "AGENT",
							targetKey: overrides.targetKey ?? testCase.agentKey,
							documentType: "GENERAL",
							storyKind: null,
							scope: overrides.scope ?? "SYSTEM",
							promptVersionId,
							isDefault: overrides.isDefault ?? true,
						},
					});
					return binding.id;
				}

				async function contentOf(
					tx: Prisma.TransactionClient,
					versionId: string,
				): Promise<string> {
					const row = await tx.promptVersion.findUniqueOrThrow({
						where: { id: versionId },
						select: { content: true },
					});
					return row.content;
				}

				it("carries a pristine SYSTEM default v1 row across, exactly once", async () => {
					await inRolledBackTransaction(async (tx) => {
						const pristine = await makePrompt(
							tx,
							"SYSTEM",
							testCase.agentKey,
							1,
						);
						await bind(tx, pristine);

						// The precondition, asserted rather than assumed: a
						// fixture that already carried the new text would make
						// every assertion below pass with the statement having
						// done nothing at all.
						expect(await contentOf(tx, pristine)).toBe(bBefore);
						expect(bBefore).not.toContain(replacement);

						expect(await tx.$executeRawUnsafe(statement)).toBe(1);

						const after = await contentOf(tx, pristine);
						expect(after).toBe(testCase.constant);
						expect(after.split(replacement).length - 1).toBe(1);
						expect(after).not.toContain(replaced);
					});
				});

				it("changes nothing on a second run", async () => {
					await inRolledBackTransaction(async (tx) => {
						const pristine = await makePrompt(
							tx,
							"SYSTEM",
							testCase.agentKey,
							1,
						);
						await bind(tx, pristine);
						expect(await tx.$executeRawUnsafe(statement)).toBe(1);
						const afterFirst = await contentOf(tx, pristine);

						// Zero rows, not "one row rewritten with the value it
						// already holds": the `NOT LIKE` guard is what makes a
						// re-apply free, and a 1 here would mean it had stopped
						// biting while the content assertion still passed.
						expect(await tx.$executeRawUnsafe(statement)).toBe(0);
						expect(await contentOf(tx, pristine)).toBe(afterFirst);
					});
				});

				it("declines a prompt an organization has versioned past v1", async () => {
					await inRolledBackTransaction(async (tx) => {
						const customised = await makePrompt(
							tx,
							"SYSTEM",
							testCase.agentKey,
							2,
						);
						await bind(tx, customised);

						expect(await tx.$executeRawUnsafe(statement)).toBe(0);
						expect(await contentOf(tx, customised)).toBe(bBefore);

						// Negative control: drop the v2 and the SAME statement
						// now matches. Without this, a predicate broken in some
						// entirely unrelated way reports the same clean zero.
						await tx.promptVersion.deleteMany({
							where: {
								promptId: (
									await tx.promptVersion.findUniqueOrThrow({
										where: { id: customised },
										select: { promptId: true },
									})
								).promptId,
								version: { gt: 1 },
							},
						});
						expect(await tx.$executeRawUnsafe(statement)).toBe(1);
						expect(await contentOf(tx, customised)).toBe(
							testCase.constant,
						);
					});
				});

				it("declines a binding that is not the default", async () => {
					await inRolledBackTransaction(async (tx) => {
						const version = await makePrompt(
							tx,
							"SYSTEM",
							testCase.agentKey,
							1,
						);
						const bindingId = await bind(tx, version, {
							isDefault: false,
						});

						expect(await tx.$executeRawUnsafe(statement)).toBe(0);
						expect(await contentOf(tx, version)).toBe(bBefore);

						// Negative control: flip the one clause that declined
						// it and the same statement matches.
						await tx.promptBinding.update({
							where: { id: bindingId },
							data: { isDefault: true },
						});
						expect(await tx.$executeRawUnsafe(statement)).toBe(1);
					});
				});

				it("leaves every other binding untouched", async () => {
					await inRolledBackTransaction(async (tx) => {
						const pristine = await makePrompt(
							tx,
							"SYSTEM",
							testCase.agentKey,
							1,
						);
						await bind(tx, pristine);

						// A different agent entirely, at the same document type
						// and story kind.
						const otherAgent = await makePrompt(
							tx,
							"SYSTEM",
							CONTROL_AGENT_KEY,
							1,
						);
						await bind(tx, otherAgent, {
							targetKey: CONTROL_AGENT_KEY,
						});

						// An organization's own fork of the same key: a
						// separate Prompt row, bound at ORG scope. This is what
						// the header of the migration means by "never reachable
						// from this predicate at all".
						const orgFork = await makePrompt(
							tx,
							"ORG",
							testCase.agentKey,
							1,
						);
						await bind(tx, orgFork, { scope: "ORG" });

						// Exactly one row, which is the half that says the
						// predicate is targeted rather than merely selective.
						expect(await tx.$executeRawUnsafe(statement)).toBe(1);

						expect(await contentOf(tx, pristine)).toBe(
							testCase.constant,
						);
						expect(await contentOf(tx, otherAgent)).toBe(bBefore);
						expect(await contentOf(tx, orgFork)).toBe(bBefore);
					});
				});
			});
		}

		it("the database's PublishingTopicPostType labels match the generated client's", async () => {
			// The only thing anywhere comparing the hand-edited schema.prisma
			// against the hand-edited `ALTER TYPE` SQL. They are two
			// independent hand edits of the same vocabulary, and a mismatch is
			// invisible until a write fails in production.
			//
			// The join runs from the COLUMN outwards rather than from a type
			// looked up by name, following publishing-suite-schema.test.ts: "a
			// six-label enum named PublishingTopicPostType exists" is satisfied
			// by a type nothing uses, which is exactly what a half-applied
			// rebuild leaves behind.
			//
			// enumlabel is Postgres type `name`, which Prisma cannot map —
			// without the ::text cast this throws rather than failing an
			// assertion.
			const rows = await db!.$queryRaw<{ label: string }[]>`
				SELECT e.enumlabel::text AS label
				FROM pg_attribute a
				JOIN pg_class c ON c.oid = a.attrelid
				JOIN pg_namespace n ON n.oid = c.relnamespace
				JOIN pg_type t ON t.oid = a.atttypid
				JOIN pg_enum e ON e.enumtypid = t.oid
				WHERE n.nspname = 'public'
				  AND c.relname = 'publishing_topic_draft'
				  AND a.attname = 'postType'
				  AND a.attnum > 0
				  AND NOT a.attisdropped
			`;

			// An empty result would mean the column is not an enum at all, and
			// a set comparison against an empty list would be answering a
			// different question.
			expect(rows.length).toBeGreaterThan(0);
			expect(new Set(rows.map((r) => r.label))).toEqual(
				new Set(Object.values(PublishingTopicPostType)),
			);
			expect(rows.map((r) => r.label)).toContain("WEBINAR_SCRIPT");
		});
	},
);
