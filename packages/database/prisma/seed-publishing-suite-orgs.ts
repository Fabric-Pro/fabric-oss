/**
 * Enrols organizations into the Publishing Suite by writing per-organization
 * feature-flag overrides.
 *
 * Exists because the admin picker is slice 4 while the feature goes live in
 * slice 3: between those, an organization has to be enrolled by some reviewable
 * means. Prefer the admin UI once it exists.
 *
 * Organization ids come from FABRIC_PUBLISHING_SUITE_SEED_ORG_IDS
 * (comma-separated) and never from a literal in this file — this repository is
 * public.
 *
 *   corepack pnpm --filter @repo/database seed:publishing-orgs
 */
import { db } from "./client";

const FLAG_KEY = "PUBLISHING_SUITE";
const ENV_VAR = "FABRIC_PUBLISHING_SUITE_SEED_ORG_IDS";
const UPDATED_BY = "seed:publishing-suite-orgs";

/**
 * The delegate calls this seed needs, injected so the decision logic can be
 * tested without a database — no database is reachable in this environment, and
 * the properties worth pinning here are all refusals (write nothing for an
 * unknown id, never echo an id, never overwrite an existing row).
 */
export interface SeedDeps {
	findOrganizations: (ids: string[]) => Promise<Array<{ id: string }>>;
	// Takes the full validated id list and writes them in ONE statement. A
	// single write is atomic by construction, which is what keeps this seed
	// all-or-nothing without a transaction: there is no per-id loop for an
	// organization deleted mid-run to interrupt.
	createOverrides: (organizationIds: string[]) => Promise<{ count: number }>;
	log?: (message: string) => void;
}

/**
 * A dependency failure re-thrown with the organization ids stripped out.
 *
 * `deps.findOrganizations` / `deps.createOverrides` can reject with a Prisma
 * error whose message echoes the whole argument object — including the ids
 * this script exists to keep out of logs (this repository is public). `name`
 * and an optional `code` are kept because they are enough to tell a
 * connection failure from a constraint violation without repeating the
 * argument dump.
 */
function opaqueDependencyError(stage: string, cause: unknown): Error {
	const name = cause instanceof Error ? cause.name : "UnknownError";
	const code =
		typeof cause === "object" && cause !== null && "code" in cause
			? String((cause as { code: unknown }).code)
			: "none";
	return new Error(
		`[seed:publishing-orgs] ${stage} failed (${name}, code ${code}). Details withheld — this repository is public and the arguments contain organization ids.`,
	);
}

/**
 * Enrols each id, returning how many organizations were NEWLY enrolled. Throws
 * without writing anything if any id matches no organization.
 */
export async function enrolOrganizations(
	rawIds: string | undefined,
	deps: SeedDeps,
): Promise<number> {
	const log = deps.log ?? console.log;
	const ids = (rawIds ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0);

	// An unset variable is a clean no-op, not a crash and not a silent
	// success: this script runs from deploy tooling where both of those
	// failure modes are invisible.
	if (ids.length === 0) {
		log(
			`[seed:publishing-orgs] ${ENV_VAR} is unset or empty — nothing to enrol.`,
		);
		return 0;
	}

	// Validate ALL ids before writing ANY. A typo'd id would otherwise insert a
	// row that resolves for nobody and is indistinguishable from a working
	// grant, and a partial write would leave the operator guessing which half
	// landed.
	let found: Array<{ id: string }>;
	try {
		found = await deps.findOrganizations(ids);
	} catch (cause) {
		throw opaqueDependencyError("looking up organizations", cause);
	}
	const known = new Set(found.map((org) => org.id));
	const unknown = ids.filter((id) => !known.has(id));
	if (unknown.length > 0) {
		// Count only. These ids identify real customers and this repository is
		// public, so the message must stay useful without naming anyone.
		throw new Error(
			`[seed:publishing-orgs] ${unknown.length} id(s) match no organization. Nothing was written. Count only — ids are not echoed.`,
		);
	}

	// A documented consequence of what this write does, not a code defect,
	// printed at the point of enrolment because a note in a plan is not where
	// an operator stands at 3am — and it must say what actually happens, not
	// an approximation of it.
	//
	// Enrolment is the availability switch, and nothing more. Until slice 3 the
	// Publishing UI was additionally gated by a build-time flag this script
	// could not touch, so a write here changed nothing an operator could see.
	// That gate is gone, so this write now decides three surfaces: the
	// deep-link Publishing page stops calling `notFound()`, the project
	// Settings → Publishing sub-tab appears (gated on the flag alone, through
	// `showPublishing`), and `assertPublishingSuiteFeatureEnabled` stops
	// refusing the API.
	//
	// It ALSO switches the project TAB on. `publishing-suite` used to sit in
	// `PROJECT_TAB_DEFAULT_HIDDEN_IDS`, so enrolment could not turn the tab on
	// across an organization and a project admin had to force-show it. Card
	// #1837's follow-up retired that default-hidden set — a project now shows
	// every tab the deployment offers — which leaves this flag as the ONLY
	// thing between enrolment and a visible tab, in every project the
	// organization owns, at once. An admin turns it OFF now, not on. The
	// warning below says so: under-stating this is the expensive direction.
	//
	// Two distinct spends follow, and they start at different times:
	//   - the manual "Generate now" route is reachable the moment this write
	//     lands (bounded by a one-hour per-project cooldown). It gates on the
	//     flag, on `Permissions.PUBLISHING_TOPIC_CREATE`, and on an ACTIVE,
	//     non-deleted project — but never on cadence. See
	//     packages/api/modules/projects/procedures/publishing-suite/generate-now.ts
	//   - the daily sweep additionally requires a project's cadence to be set
	//     away from MANUAL, which is the default and is only changed through
	//     Settings. MANUAL is `DEFAULT_PUBLISHING_CADENCE`, applied by
	//     `publishingSuiteSettingsDefaults` without writing a row; the sweep's
	//     `findEligibleProjects` is what filters on it.
	//
	// Printed unconditionally, with no prompt: this runs from deploy tooling
	// where stdin is not a terminal.
	log(
		`[seed:publishing-orgs] WARNING: enrolling ${ids.length} organization(s) makes the Publishing Suite visible to members of those organizations — the deep-link Publishing page stops 404ing, the project Settings → Publishing sub-tab appears, the API stops refusing, and the project TAB appears in EVERY project those organizations own (a project admin now has to turn it off, not on). It also opens the manual "Generate now" route immediately: that route gates on the PUBLISHING_SUITE flag, the caller's PUBLISHING_TOPIC_CREATE permission and an active project, but never on cadence, so any active project in these organizations can trigger a model-inference generation on demand once this write lands (bounded only by a one-hour per-project cooldown). The daily sweep is narrower: it additionally requires a project's cadence to be set away from MANUAL through Settings.`,
	);

	// One statement for every row: atomic by construction, so there is no
	// window between "validated" and "written" for an organization to be
	// deleted in. `count` is what the database actually inserted — an
	// existing row (left alone by `skipDuplicates`) does not add to it.
	let result: { count: number };
	try {
		result = await deps.createOverrides(ids);
	} catch (cause) {
		throw opaqueDependencyError("writing overrides", cause);
	}
	log(
		`[seed:publishing-orgs] enrolled ${result.count} of ${ids.length} organizations`,
	);
	return result.count;
}

/**
 * The real dependencies `main()` wires into `enrolOrganizations`, extracted
 * into its own factory so a test can exercise `main()`'s ACTUAL write path
 * against a stubbed Prisma client — not a hand-written double that merely
 * assumes the same shape. `createOverrides` is `create`-only on conflict: an
 * existing row is LEFT ALONE, including one an operator has deliberately set
 * to false through the admin UI. An upsert here would resurrect a disabled
 * organization on the next deploy — a flag that turns itself back on months
 * later. All rows go in through this one `createMany` call, so the write is
 * atomic and there is no per-id loop for a mid-run deletion to interrupt.
 */
export function buildSeedDeps(
	dbClient: Pick<
		typeof db,
		"organization" | "organizationFeatureFlagOverride"
	>,
): SeedDeps {
	return {
		findOrganizations: (ids) =>
			dbClient.organization.findMany({
				where: { id: { in: ids } },
				select: { id: true },
			}),
		createOverrides: (organizationIds) =>
			dbClient.organizationFeatureFlagOverride.createMany({
				data: organizationIds.map((organizationId) => ({
					key: FLAG_KEY,
					organizationId,
					enabled: true,
					updatedBy: UPDATED_BY,
				})),
				skipDuplicates: true,
			}),
	};
}

async function main(): Promise<void> {
	await enrolOrganizations(process.env[ENV_VAR], buildSeedDeps(db));
}

// Run only when invoked directly (the seed:publishing-orgs npm scripts do
// exactly that). Guarded because this module is also imported by
// __tests__/seed-publishing-suite-orgs.test.ts, and an unguarded main()
// would run — and touch the Prisma client — on every test import. Today
// that happens to be harmless only because vitest sets a placeholder
// DATABASE_URL and the org-ids variable is unset; isolation that depends
// on two unrelated defaults is not isolation.
if (require.main === module) {
	main()
		.catch((error) => {
			console.error(error);
			process.exit(1);
		})
		.finally(async () => {
			await db.$disconnect();
		});
}
