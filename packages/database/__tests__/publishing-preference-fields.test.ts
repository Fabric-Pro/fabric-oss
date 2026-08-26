import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../index";
import {
	getPublishingSuiteSettings,
	upsertPublishingSuiteSettings,
} from "../prisma/queries/projects/publishing-settings";
import { buildPublishingPreferencesSnapshot } from "../src/publishing-preferences";

/**
 * REAL-DB integration test for the three advisory preference columns (1C-1b
 * part 2, §7.1(a) / FR8–FR10).
 *
 * Three of these cases cannot be answered by a mock, which is why the file is
 * here rather than beside the pure snapshot tests:
 *
 *   - whether `PUBLISHING_SUITE_SETTINGS_PUBLIC_SELECT` actually carries the
 *     new columns, which is invisible to types and to any test that reads the
 *     row back through a stub;
 *   - whether a row written BEFORE these columns existed still reads (the
 *     migration's correctness on a populated table is a property of the DDL);
 *   - whether the post-type COLUMN refuses a value outside its enum, which the
 *     generated client makes uncompilable and therefore untestable through
 *     Prisma.
 *
 * Gated on RUN_DB_INTEGRATION exactly like the sibling publishing-*.test.ts
 * files — db-integration.yml sets that variable and nothing else, so a
 * DATABASE_URL-keyed gate would self-skip inside the very job meant to run it,
 * which is a false pass rather than a missing run.
 */
const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const projectIds: string[] = [];
const createdUserIds: string[] = [];

async function seedPersonalProject(name: string) {
	const user = await db.user.create({
		data: {
			id: `pub-preffield-${randomUUID()}`,
			name: "pub-preffield",
			email: `pub-preffield-${randomUUID()}@test.local`,
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(user.id);
	const project = await db.project.create({
		data: {
			name,
			userId: user.id,
			status: "ACTIVE",
			techStack: [],
			features: [],
			tags: [],
		},
	});
	projectIds.push(project.id);
	return { project, user };
}

/** Every case that needs a stored row starts from the same populated state. */
async function seedSettings(projectId: string, userId: string) {
	await upsertPublishingSuiteSettings({
		projectId,
		clientOrganizationId: null,
		createdByUserId: userId,
		preferredThemes: ["Developer Experience", "Release Engineering"],
		preferredPostTypes: ["BLOG_POST", "CASE_STUDY"],
		strategicPriorities: "Ship weekly.\nName the trade-off.",
	});
}

afterAll(async () => {
	if (!RUN_DB) {
		return;
	}
	if (projectIds.length > 0) {
		await db.publishingSuiteSettings.deleteMany({
			where: { projectId: { in: projectIds } },
		});
		await db.project.deleteMany({ where: { id: { in: projectIds } } });
	}
	if (createdUserIds.length > 0) {
		await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
	await db.$disconnect();
});

describe.skipIf(!RUN_DB)("publishing preference fields", () => {
	it("returns empty values for a project with no settings row", async () => {
		const { project } = await seedPersonalProject("prefs-no-row");

		const settings = await getPublishingSuiteSettings(project.id);

		expect(settings.preferredThemes).toEqual([]);
		expect(settings.preferredPostTypes).toEqual([]);
		expect(settings.strategicPriorities).toBeNull();
	});

	it("leaves stored values untouched when the upsert omits all three", async () => {
		const { project, user } = await seedPersonalProject("prefs-omitted");
		await seedSettings(project.id, user.id);

		// A save from a form that only touches cadence must not wipe preferences
		// it never showed.
		await upsertPublishingSuiteSettings({
			projectId: project.id,
			clientOrganizationId: null,
			createdByUserId: user.id,
			cadence: "WEEKLY",
		});

		const settings = await getPublishingSuiteSettings(project.id);
		expect(settings.preferredThemes).toEqual([
			"Developer Experience",
			"Release Engineering",
		]);
		expect(settings.preferredPostTypes).toEqual([
			"BLOG_POST",
			"CASE_STUDY",
		]);
		expect(settings.strategicPriorities).toBe(
			"Ship weekly.\nName the trade-off.",
		);
	});

	it("treats an empty list as the off switch, not as unchanged", async () => {
		const { project, user } = await seedPersonalProject("prefs-clear-list");
		await seedSettings(project.id, user.id);

		await upsertPublishingSuiteSettings({
			projectId: project.id,
			clientOrganizationId: null,
			createdByUserId: user.id,
			preferredThemes: [],
		});

		const settings = await getPublishingSuiteSettings(project.id);
		expect(settings.preferredThemes).toEqual([]);
		// The other two are untouched — clearing one list must not clear the rest.
		expect(settings.preferredPostTypes).toEqual([
			"BLOG_POST",
			"CASE_STUDY",
		]);
	});

	it("clears the free text when strategicPriorities is null", async () => {
		const { project, user } = await seedPersonalProject("prefs-clear-text");
		await seedSettings(project.id, user.id);

		await upsertPublishingSuiteSettings({
			projectId: project.id,
			clientOrganizationId: null,
			createdByUserId: user.id,
			strategicPriorities: null,
		});

		const settings = await getPublishingSuiteSettings(project.id);
		expect(settings.strategicPriorities).toBeNull();
	});

	it("leaves the free text alone when strategicPriorities is undefined", async () => {
		const { project, user } = await seedPersonalProject("prefs-keep-text");
		await seedSettings(project.id, user.id);

		await upsertPublishingSuiteSettings({
			projectId: project.id,
			clientOrganizationId: null,
			createdByUserId: user.id,
			strategicPriorities: undefined,
		});

		const settings = await getPublishingSuiteSettings(project.id);
		expect(settings.strategicPriorities).toBe(
			"Ship weekly.\nName the trade-off.",
		);
	});

	it("returns all three through the public select", async () => {
		// The guard for a missing entry in PUBLISHING_SUITE_SETTINGS_PUBLIC_SELECT.
		// Nothing else in the slice notices: the write succeeds, the column holds
		// the value, and only the read comes back short.
		const { project, user } = await seedPersonalProject("prefs-roundtrip");
		await seedSettings(project.id, user.id);

		const settings = await getPublishingSuiteSettings(project.id);

		expect(settings.preferredThemes).toEqual([
			"Developer Experience",
			"Release Engineering",
		]);
		expect(settings.preferredPostTypes).toEqual([
			"BLOG_POST",
			"CASE_STUDY",
		]);
		expect(settings.strategicPriorities).toBe(
			"Ship weekly.\nName the trade-off.",
		);
	});

	it("feeds the C-1 snapshot builder the stored values", async () => {
		// The end-to-end pin that the storage layer and the fingerprint actually
		// meet. Without it the columns could exist, the form could write them, and
		// the snapshot could keep hashing empty lists forever.
		const { project, user } = await seedPersonalProject("prefs-snapshot");
		await seedSettings(project.id, user.id);

		const snapshot = buildPublishingPreferencesSnapshot(
			await getPublishingSuiteSettings(project.id),
		);

		// Sorted by the snapshot builder, case preserved on both lists.
		expect(snapshot.preferredThemes).toEqual([
			"Developer Experience",
			"Release Engineering",
		]);
		expect(snapshot.preferredPostTypes).toEqual([
			"BLOG_POST",
			"CASE_STUDY",
		]);
		expect(snapshot.strategicPriorities).toBe(
			"Ship weekly.\nName the trade-off.",
		);
	});

	it("still reads a settings row written before these columns existed", async () => {
		// The upgrade path. Insert through raw SQL naming ONLY the pre-existing
		// columns, which is what every row in a live deployment looks like the
		// moment the migration lands. If the two array columns were added without
		// a DEFAULT the migration would have been refused outright; this proves
		// the successful variant leaves old rows readable rather than null.
		const { project, user } = await seedPersonalProject("prefs-upgrade");
		await db.$executeRaw`
			INSERT INTO "publishing_suite_settings"
				("id", "projectId", "organizationId", "userId", "cadence",
				 "notificationsEnabled", "createdByUserId", "createdAt", "updatedAt")
			VALUES (${`legacy-${randomUUID()}`}, ${project.id}, NULL, ${user.id},
				'WEEKLY', true, ${user.id}, now(), now())
		`;

		const settings = await getPublishingSuiteSettings(project.id);

		expect(settings.preferredThemes).toEqual([]);
		expect(settings.preferredPostTypes).toEqual([]);
		expect(settings.strategicPriorities).toBeNull();
	});

	it("stores post types as the closed ENUM array, not as text", async () => {
		// Asserted against the system catalog rather than by trying to write a
		// bad value, and the reason is worth recording. Two earlier drafts were
		// green for the wrong reason:
		//
		//   `.rejects.toThrow()`  — passed while the column did not exist at all;
		//                           "column does not exist" is also a throw.
		//   `.rejects.toThrow(/invalid input value for enum/)`
		//                         — still passed, because
		//                           ARRAY['NEWSLETTER']::"PublishingTopicPostType"[]
		//                           fails on the CAST, before Postgres ever looks
		//                           at the target column. The literal can never
		//                           reach the column, so no write can distinguish
		//                           an enum column from a text one.
		//
		// The property that actually matters is the column's TYPE. `_Name` is
		// Postgres's spelling for "array of Name", so an enum array reads as
		// `_PublishingTopicPostType` and a `String[]` would read as `_text` —
		// which is precisely the mistake this case exists to catch.
		const rows = await db.$queryRaw<{ udt: string }[]>`
			SELECT c.udt_name::text AS udt
			FROM information_schema.columns c
			WHERE c.table_name = 'publishing_suite_settings'
				AND c.column_name = 'preferredPostTypes'
		`;

		expect(rows).toHaveLength(1);
		expect(rows[0]?.udt).toBe("_PublishingTopicPostType");
	});
});
