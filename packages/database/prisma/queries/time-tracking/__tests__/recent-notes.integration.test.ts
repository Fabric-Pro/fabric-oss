/**
 * Real-Postgres proof of which notes `listRecentTimeEntryNotes` offers.
 *
 * The unit test pins the WHERE the query sends. Only Postgres can show what
 * the grouping returns: one note per text, dated by its latest save, newest
 * first, with other people's, other projects' and confirmed suggestions'
 * notes left out.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder, mirroring the
 * sibling integration suites.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma } from "../../../client";
import { listRecentTimeEntryNotes } from "../time-entries";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-recent-notes-org-${RUN_ID}`;
const USER_ID = `test-recent-notes-user-${RUN_ID}`;
const OTHER_USER_ID = `test-recent-notes-other-${RUN_ID}`;

describe.skipIf(!hasReachableDatabaseUrl())(
	"recent time entry notes (real Postgres)",
	() => {
		let projectId = "";
		let otherProjectId = "";

		beforeAll(async () => {
			const now = new Date();
			for (const id of [USER_ID, OTHER_USER_ID]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
					VALUES (${id}, ${"Recent Notes User"}, ${`${id}@example.com`}, true, false, ${now}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Recent Notes Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			const project = await db.project.create({
				data: {
					name: "Recent Notes Project",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});
			const otherProject = await db.project.create({
				data: {
					name: "Recent Notes Other Project",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});
			projectId = project.id;
			otherProjectId = otherProject.id;
		});

		afterEach(async () => {
			await db.timeEntry.deleteMany({
				where: { organizationId: ORG_ID },
			});
		});

		afterAll(async () => {
			await db.project.deleteMany({ where: { organizationId: ORG_ID } });
			await db.$executeRaw(
				Prisma.sql`DELETE FROM "organization" WHERE id = ${ORG_ID}`,
			);
			await db.$executeRaw(
				Prisma.sql`DELETE FROM "user" WHERE id IN (${USER_ID}, ${OTHER_USER_ID})`,
			);
		});

		/** One entry, last saved `minute` minutes into the day. */
		async function seedEntry(entry: {
			description: string | null;
			minute: number;
			userId?: string;
			projectId?: string;
			sourceSuggestionId?: string;
		}) {
			const created = await db.timeEntry.create({
				data: {
					organizationId: ORG_ID,
					projectId: entry.projectId ?? projectId,
					userId: entry.userId ?? USER_ID,
					workDate: new Date("2026-11-18T00:00:00Z"),
					timezone: "UTC",
					durationMinutes: 30,
					activity: "DEVELOPMENT",
					billable: true,
					description: entry.description,
					startStopRequired: false,
					sourceSuggestionId: entry.sourceSuggestionId ?? null,
				},
			});
			// Raw SQL, so Prisma's `@updatedAt` does not overwrite the stamp.
			const savedAt = new Date(
				Date.UTC(2026, 10, 18, 0, entry.minute, 0),
			);
			await db.$executeRaw(
				Prisma.sql`UPDATE time_entry SET "updatedAt" = ${savedAt} WHERE id = ${created.id}`,
			);
		}

		function recentNotes(limit = 5) {
			return listRecentTimeEntryNotes({
				organizationId: ORG_ID,
				projectId,
				userId: USER_ID,
				limit,
			});
		}

		it("offers the five most recently saved distinct notes, newest first", async () => {
			for (let n = 1; n <= 10; n++) {
				await seedEntry({ description: `Note ${n}`, minute: n });
			}
			// Saving a note again makes it the most recent use.
			await seedEntry({ description: "Note 3", minute: 11 });

			expect(await recentNotes()).toEqual([
				"Note 3",
				"Note 10",
				"Note 9",
				"Note 8",
				"Note 7",
			]);
		});

		it("leaves out other people's notes, other projects' notes, confirmed suggestions and empty notes", async () => {
			await seedEntry({ description: "Mine", minute: 1 });
			await seedEntry({
				description: "Someone else's",
				minute: 2,
				userId: OTHER_USER_ID,
			});
			await seedEntry({
				description: "Other project",
				minute: 3,
				projectId: otherProjectId,
			});
			await seedEntry({
				description: "Confirmed suggestion",
				minute: 4,
				sourceSuggestionId: `suggestion-${RUN_ID}`,
			});
			await seedEntry({ description: null, minute: 5 });

			expect(await recentNotes()).toEqual(["Mine"]);
		});

		it("shows every note when there are fewer than the limit, ties by text", async () => {
			await seedEntry({ description: "Beta", minute: 7 });
			await seedEntry({ description: "Alpha", minute: 7 });

			expect(await recentNotes()).toEqual(["Alpha", "Beta"]);
		});
	},
);
