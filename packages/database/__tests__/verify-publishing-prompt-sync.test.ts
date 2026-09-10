/**
 * `checkPublishingPromptSync` against an in-memory fake — no live database.
 *
 * The function under test takes its database access as an injected
 * three-method interface (`PublishingPromptSyncDb`), so every case here is a
 * plain async function backed by in-memory arrays. Nothing imports
 * `../prisma/client` or touches `DATABASE_URL`; there is no `hasReachableDatabaseUrl()`
 * gate anywhere in this file because there is nothing here that needs one.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/verify-publishing-prompt-sync.test.ts
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	checkPublishingPromptSync,
	type PublishingPromptSyncDb,
} from "../scripts/verify-publishing-prompt-sync";

const WEBINAR_SCRIPT_KEY = "publishing_topic_webinar_script";
const PLANNING_ANALYSIS_KEY = "publishing_topic_planning_analysis";
const TOPIC_SUGGESTION_KEY = "publishing_topic_suggestion";

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

	it("checks exactly the three Publishing Suite prompt keys this slice ships", async () => {
		// A Newsletter Blurb prompt key is not part of this list: it belongs
		// to slice 2D-2 and has no agent-key constant anywhere in this
		// codebase yet.
		const report = await checkPublishingPromptSync(fixtures.db);

		expect(report.map((r) => r.key).sort()).toEqual(
			[
				PLANNING_ANALYSIS_KEY,
				TOPIC_SUGGESTION_KEY,
				WEBINAR_SCRIPT_KEY,
			].sort(),
		);
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

	it("reports a sync-migration key still carrying the pre-migration body", async () => {
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

	it("reports OK for a sync-migration key whose live version already carries the migration text", async () => {
		fixtures.seedFullRow(
			TOPIC_SUGGESTION_KEY,
			"Recommend it when the topic has something to show — a running order for a live session someone presents.",
		);

		const report = await checkPublishingPromptSync(fixtures.db);

		expect(report.find((r) => r.key === TOPIC_SUGGESTION_KEY)?.status).toBe(
			"OK",
		);
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

	it("reports CUSTOMIZED for an edited prompt even when the body happens to carry the migration text", async () => {
		// The control on the case above: were the version check ordered after
		// the text check, an admin edit that kept the shipped paragraph would
		// report a bare OK, and neither case could tell a v1 row from a v2
		// one. Ordering the version check FIRST is what this pins.
		fixtures.seedFullRow(
			TOPIC_SUGGESTION_KEY,
			"An admin's own opening, then a running order for a live session someone presents.",
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
			"Recommend it when the topic has something to show — a running order for a live session someone presents.",
		);

		const report = await checkPublishingPromptSync(fixtures.db);

		expect(report.find((r) => r.key === TOPIC_SUGGESTION_KEY)?.status).toBe(
			"OK",
		);
	});
});
