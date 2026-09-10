/**
 * `createPrismaPromptSyncDb` against a REAL Postgres.
 *
 * `verify-publishing-prompt-sync.test.ts` proves the resolution logic
 * (`checkPublishingPromptSync`, `resolveBoundVersion`) against an in-memory
 * fake of `PublishingPromptSyncDb` — nothing in that file ever issues a
 * query. This file proves the other half: that the Prisma queries
 * `createPrismaPromptSyncDb` builds (`promptBinding.findFirst`,
 * `promptVersion.findUnique`, `prompt.findFirst`) actually match the row
 * shape a real environment has, rather than only matching the interface
 * shape a hand-written fake happens to implement.
 *
 * Two properties here CANNOT be established by a fake at all, because both
 * are facts about Postgres index semantics rather than about this code:
 *
 *  - A binding that has moved past v1. `createPromptVersion` repoints a
 *    prompt's same-scope bindings at each new version, so an edited SYSTEM
 *    prompt leaves the binding on v2 — and the adapter has to report v2's
 *    number and body, from a real `promptVersion` row with a real
 *    `@@unique([promptId, version])` behind it.
 *  - TWO SYSTEM `prompt` rows for one key. That is legal because `prompt`'s
 *    unique key is NULL-distinct in Postgres and both rows null `userId` and
 *    `organizationId`; a fake with a hand-written uniqueness rule would
 *    either forbid the state or permit it for the wrong reason. The case
 *    below inserts both rows and asserts the insert is accepted, then that
 *    resolution still lands on the bound one.
 *
 * The negative control on `documentType` earns its place for a third reason:
 * every other field the binding predicate filters on (`targetType`, `scope`,
 * `storyKind`) is a Prisma enum, so a typo'd value there fails
 * `pnpm type-check` before it ever reaches Postgres. `documentType` is a
 * plain `String` column with no enum behind it — a value drift there
 * (a rename, a case change) type-checks cleanly and would only ever be
 * caught by a query that actually runs.
 *
 * Hermetic: every fixture uses a synthetic agent key
 * (`FIXTURE_AGENT_KEY`) that no seed or migration in this repository ever
 * targets, and every case runs inside a transaction that is rolled back —
 * the same pattern
 * `__tests__/migrations/sync-prompt-migrations-apply.test.ts` uses. Self-skips
 * when no reachable `DATABASE_URL` is present (see
 * `_helpers/db-availability.ts`); not added to `vitest.config.ts`'s
 * `INTEGRATION_TESTS` exclude list, matching
 * `sync-prompt-migrations-apply.test.ts` and
 * `org-feature-flags.integration.test.ts` — the self-skip already keeps a
 * default `pnpm --filter @repo/database test` run clean without one.
 *
 * Run locally (Aspire Postgres up):
 *   pnpm --filter @repo/database exec dotenv -c -e ../../.env.local -- \
 *     vitest run __tests__/verify-publishing-prompt-sync.integration.test.ts
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "../prisma/generated/client";
import { createPrismaPromptSyncDb } from "../scripts/verify-publishing-prompt-sync";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const SHOULD_RUN = hasReachableDatabaseUrl();

/** A prompt key no seed or migration in this repository ever targets. */
const FIXTURE_AGENT_KEY = "publishing_prompt_sync_adapter_fixture_agent";

const FIXTURE_CREATED_BY = "publishing-prompt-sync-adapter-fixture";

let db: typeof import("../prisma/client").db | undefined;

beforeAll(async () => {
	if (!SHOULD_RUN) {
		return;
	}
	const dbModule = await import("../prisma/client");
	db = dbModule.db;
});

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

/**
 * The row shapes `seed-prompts-only.ts` actually writes for a Publishing Suite
 * agent key, as three helpers rather than repeated `create` calls: the binding
 * tuple in particular (documentType "GENERAL", storyKind null, scope "SYSTEM",
 * targetType "AGENT", isDefault true) is the thing under test, and eight
 * hand-copied literals of it would drift.
 */
async function createFixturePrompt(tx: Prisma.TransactionClient) {
	return tx.prompt.create({
		data: {
			key: FIXTURE_AGENT_KEY,
			name: "fixture prompt",
			scope: "SYSTEM",
			createdBy: FIXTURE_CREATED_BY,
		},
	});
}

async function createFixtureVersion(
	tx: Prisma.TransactionClient,
	promptId: string,
	version: number,
	content: string,
) {
	return tx.promptVersion.create({
		data: {
			promptId,
			version,
			content,
			createdBy: FIXTURE_CREATED_BY,
			scope: "SYSTEM",
		},
	});
}

async function createFixtureBinding(
	tx: Prisma.TransactionClient,
	promptVersionId: string,
	overrides: { documentType?: string; isDefault?: boolean } = {},
) {
	return tx.promptBinding.create({
		data: {
			targetType: "AGENT",
			targetKey: FIXTURE_AGENT_KEY,
			documentType: overrides.documentType ?? "GENERAL",
			storyKind: null,
			scope: "SYSTEM",
			promptVersionId,
			isDefault: overrides.isDefault ?? true,
		},
	});
}

describe.skipIf(!SHOULD_RUN)("createPrismaPromptSyncDb (real DB)", () => {
	it("resolves nothing for a key with no binding and no prompt row at all", async () => {
		await inRolledBackTransaction(async (tx) => {
			const adapter = createPrismaPromptSyncDb(tx);

			expect(
				await adapter.findDefaultSystemAgentBinding(FIXTURE_AGENT_KEY),
			).toBeNull();
			expect(await adapter.systemPromptRowExists(FIXTURE_AGENT_KEY)).toBe(
				false,
			);
		});
	});

	it("sees the prompt row but no binding when only the prompt row exists", async () => {
		// The half-run seed. `systemPromptRowExists` is the only thing that
		// separates this from the case above, and the two carry different
		// remedies in the operator-facing detail.
		await inRolledBackTransaction(async (tx) => {
			await createFixturePrompt(tx);

			const adapter = createPrismaPromptSyncDb(tx);

			expect(await adapter.systemPromptRowExists(FIXTURE_AGENT_KEY)).toBe(
				true,
			);
			expect(
				await adapter.findDefaultSystemAgentBinding(FIXTURE_AGENT_KEY),
			).toBeNull();
		});
	});

	it("finds no binding when the prompt and a version exist alone", async () => {
		await inRolledBackTransaction(async (tx) => {
			const prompt = await createFixturePrompt(tx);
			await createFixtureVersion(tx, prompt.id, 1, "fixture body");

			const adapter = createPrismaPromptSyncDb(tx);

			expect(
				await adapter.findDefaultSystemAgentBinding(FIXTURE_AGENT_KEY),
			).toBeNull();
		});
	});

	it("resolves the full chain for a row shaped exactly like the seed's", async () => {
		await inRolledBackTransaction(async (tx) => {
			const prompt = await createFixturePrompt(tx);
			const version = await createFixtureVersion(
				tx,
				prompt.id,
				1,
				"fixture body",
			);
			const binding = await createFixtureBinding(tx, version.id);

			const adapter = createPrismaPromptSyncDb(tx);

			const foundBinding =
				await adapter.findDefaultSystemAgentBinding(FIXTURE_AGENT_KEY);
			expect(foundBinding).toEqual({
				id: binding.id,
				promptVersionId: version.id,
			});

			expect(await adapter.findPromptVersionById(version.id)).toEqual({
				id: version.id,
				version: 1,
				content: "fixture body",
			});
		});
	});

	it("resolves the v2 body, not the v1 one, once the binding has been repointed", async () => {
		// What an admin editing a SYSTEM prompt in the Prompt Library leaves
		// behind: `createPromptVersion` inserts v2 and moves the same-scope
		// binding onto it. Both versions are inserted here so the assertion
		// distinguishes "read the bound version" from "read the only version"
		// — with v1 absent, an adapter that ignored the binding's
		// `promptVersionId` entirely would still pass.
		await inRolledBackTransaction(async (tx) => {
			const prompt = await createFixturePrompt(tx);
			const v1 = await createFixtureVersion(
				tx,
				prompt.id,
				1,
				"the seeded body",
			);
			const v2 = await createFixtureVersion(
				tx,
				prompt.id,
				2,
				"the body an admin edited",
			);
			await createFixtureBinding(tx, v2.id);

			const adapter = createPrismaPromptSyncDb(tx);

			const binding =
				await adapter.findDefaultSystemAgentBinding(FIXTURE_AGENT_KEY);
			expect(binding?.promptVersionId).toBe(v2.id);
			expect(binding?.promptVersionId).not.toBe(v1.id);

			expect(
				await adapter.findPromptVersionById(binding!.promptVersionId),
			).toEqual({
				id: v2.id,
				version: 2,
				content: "the body an admin edited",
			});
		});
	});

	it("resolves the bound row when a SECOND, unbound SYSTEM prompt row shares the key", async () => {
		// Both inserts succeeding IS half the assertion: `prompt`'s unique key
		// is (key, scope, userId, organizationId) and Postgres treats NULL as
		// distinct in a plain unique index, so two SYSTEM rows for one key are
		// legal. Were that ever tightened, this insert would throw and the
		// case would report it rather than quietly becoming a duplicate of the
		// one above.
		await inRolledBackTransaction(async (tx) => {
			const unbound = await createFixturePrompt(tx);
			const bound = await createFixturePrompt(tx);
			expect(bound.id).not.toBe(unbound.id);

			// The decoy carries a version too, so a resolution that picked a
			// prompt row first would find a complete-looking chain on it.
			await createFixtureVersion(
				tx,
				unbound.id,
				1,
				"the duplicate row's body",
			);
			const version = await createFixtureVersion(
				tx,
				bound.id,
				1,
				"the bound row's body",
			);
			await createFixtureBinding(tx, version.id);

			const adapter = createPrismaPromptSyncDb(tx);

			const binding =
				await adapter.findDefaultSystemAgentBinding(FIXTURE_AGENT_KEY);
			expect(binding?.promptVersionId).toBe(version.id);
			expect(
				(await adapter.findPromptVersionById(binding!.promptVersionId))
					?.content,
			).toBe("the bound row's body");
		});
	});

	it("returns null for a promptVersionId that names no row", async () => {
		// The dangling-binding state. `findUnique` on a missing id has to come
		// back null rather than throw, or the script exits 2 as an unexpected
		// error instead of reporting MISSING.
		await inRolledBackTransaction(async (tx) => {
			const adapter = createPrismaPromptSyncDb(tx);

			expect(
				await adapter.findPromptVersionById(
					"version-id-that-names-no-row",
				),
			).toBeNull();
		});
	});

	it("does not match a binding whose documentType differs from the predicate (negative control)", async () => {
		// documentType is a plain String column, not a Prisma enum — a typo or
		// a seed-script drift here type-checks fine and would silently slip
		// past `pnpm type-check`. Without this case, a predicate that dropped
		// the documentType filter entirely (matching any binding on the
		// target key) would report the same clean pass as the cases above.
		await inRolledBackTransaction(async (tx) => {
			const prompt = await createFixturePrompt(tx);
			const version = await createFixtureVersion(
				tx,
				prompt.id,
				1,
				"fixture body",
			);
			await createFixtureBinding(tx, version.id, {
				documentType: "STAGE",
			});

			const adapter = createPrismaPromptSyncDb(tx);

			expect(
				await adapter.findDefaultSystemAgentBinding(FIXTURE_AGENT_KEY),
			).toBeNull();
		});
	});

	it("does not match a binding that is not the default (negative control)", async () => {
		// `isDefault: false` is a binding stood down rather than deleted — an
		// available offer in the catalog, not the row the runtime resolves. A
		// predicate that dropped this filter would report a stood-down tier as
		// the live one.
		await inRolledBackTransaction(async (tx) => {
			const prompt = await createFixturePrompt(tx);
			const version = await createFixtureVersion(
				tx,
				prompt.id,
				1,
				"fixture body",
			);
			await createFixtureBinding(tx, version.id, { isDefault: false });

			const adapter = createPrismaPromptSyncDb(tx);

			expect(
				await adapter.findDefaultSystemAgentBinding(FIXTURE_AGENT_KEY),
			).toBeNull();
		});
	});
});
