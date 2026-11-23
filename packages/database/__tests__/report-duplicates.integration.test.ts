/**
 * Real-Postgres proof of which reports `findLikelyDuplicateReports` finds.
 *
 * The unit test mocks Prisma, so it can only pin the SQL the query sends.
 * Only Postgres can show that the comparison covers every report in scope,
 * however old, with the same case and whitespace rules as the JavaScript
 * check, a report's own prompt over its template's, and only the latest
 * version of each report.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder, mirroring
 * the sibling integration suites.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import { findLikelyDuplicateReports } from "../prisma/queries/report-instance-lookups";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-report-duplicates-org-${RUN_ID}`;
const OTHER_ORG_ID = `test-report-duplicates-other-org-${RUN_ID}`;
const USER_ID = `test-report-duplicates-user-${RUN_ID}`;
const TEMPLATE_ID = `test-report-duplicates-template-${RUN_ID}`;
const OTHER_TEMPLATE_ID = `test-report-duplicates-other-template-${RUN_ID}`;
const NO_BREAK_SPACE = String.fromCharCode(0xa0);

describe.skipIf(!hasReachableDatabaseUrl())(
	"likely duplicate reports (real Postgres)",
	() => {
		let projectId = "";

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Report Duplicates User"}, ${`${USER_ID}@example.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			for (const id of [ORG_ID, OTHER_ORG_ID]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "organization" (id, name, slug, "createdAt")
					VALUES (${id}, ${"Report Duplicates Org"}, ${id}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
				await db.member.create({
					data: {
						id: `${id}-member`,
						organizationId: id,
						userId: USER_ID,
						role: "owner",
						createdAt: now,
					},
				});
			}
			const project = await db.project.create({
				data: {
					name: "Report Duplicates Project",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});
			projectId = project.id;
			for (const [id, organizationId] of [
				[TEMPLATE_ID, ORG_ID],
				[OTHER_TEMPLATE_ID, OTHER_ORG_ID],
			]) {
				await db.reportTemplate.create({
					data: {
						id,
						name: "Status template",
						templateType: "CUSTOM",
						definition: { userPrompt: "Summarize the week." },
						userId: USER_ID,
						organizationId,
						scope: "ORGANIZATION",
					},
				});
			}
		});

		afterEach(async () => {
			await db.templateInstance.deleteMany({
				where: { organizationId: { in: [ORG_ID, OTHER_ORG_ID] } },
			});
		});

		afterAll(async () => {
			await db.reportTemplate.deleteMany({
				where: { id: { in: [TEMPLATE_ID, OTHER_TEMPLATE_ID] } },
			});
			await db.project.deleteMany({ where: { organizationId: ORG_ID } });
			await db.member.deleteMany({ where: { userId: USER_ID } });
			await db.$executeRaw(
				Prisma.sql`DELETE FROM "organization" WHERE id IN (${ORG_ID}, ${OTHER_ORG_ID})`,
			);
			await db.$executeRaw(
				Prisma.sql`DELETE FROM "user" WHERE id = ${USER_ID}`,
			);
		});

		/** One report, last saved `minute` minutes into the day. */
		async function seedReport(report: {
			name: string;
			minute: number;
			sId?: string;
			version?: number;
			status?: "ACTIVE" | "DRAFT" | "ARCHIVED";
			connections?: Prisma.InputJsonValue;
			organizationId?: string;
			templateId?: string;
		}) {
			const organizationId = report.organizationId ?? ORG_ID;
			const created = await db.templateInstance.create({
				data: {
					templateId: report.templateId ?? TEMPLATE_ID,
					userId: USER_ID,
					organizationId,
					projectId,
					name: report.name,
					connections: report.connections ?? {},
					...(report.sId ? { sId: report.sId } : {}),
					version: report.version ?? 1,
					status: report.status ?? "ACTIVE",
				},
			});
			// Raw SQL, so Prisma's `@updatedAt` does not overwrite the stamp.
			const savedAt = new Date(
				Date.UTC(2026, 10, 18, 0, report.minute, 0),
			);
			await db.$executeRaw(
				Prisma.sql`UPDATE template_instance SET "updatedAt" = ${savedAt} WHERE id = ${created.id}`,
			);
			return created.id;
		}

		function duplicates(query: { name?: string; prompt?: string }) {
			return findLikelyDuplicateReports({
				userId: USER_ID,
				organizationId: ORG_ID,
				projectId,
				name: query.name ?? "",
				prompt: query.prompt ?? "",
			});
		}

		it("finds a match older than hundreds of newer reports", async () => {
			const oldest = await seedReport({
				name: "Weekly status",
				minute: 0,
			});
			await db.templateInstance.createMany({
				data: Array.from({ length: 600 }, (_, n) => ({
					templateId: TEMPLATE_ID,
					userId: USER_ID,
					organizationId: ORG_ID,
					projectId,
					name: `Report ${n}`,
					connections: {
						promptOverride: `Prompt ${n}`,
						promptOverrideSource: "user",
					},
				})),
			});

			const matches = await duplicates({ name: "Weekly status" });

			expect(matches.map((match) => match.id)).toEqual([oldest]);
		});

		it("matches the title ignoring case and whitespace, as the JavaScript check does", async () => {
			const id = await seedReport({
				name: `  Weekly${NO_BREAK_SPACE} STATUS\t`,
				minute: 1,
			});
			await seedReport({ name: "Weeklystatus", minute: 2 });

			const matches = await duplicates({ name: "weekly status" });

			expect(matches).toEqual([
				expect.objectContaining({
					id,
					sameTitle: true,
					samePrompt: false,
				}),
			]);
		});

		it("compares a report's own prompt over its template's, and the template's for an unmarked copy", async () => {
			const own = await seedReport({
				name: "Own prompt",
				minute: 1,
				connections: {
					promptOverride: "Only blockers.",
					promptOverrideSource: "user",
				},
			});
			const unmarked = await seedReport({
				name: "Unmarked copy",
				minute: 2,
				connections: { promptOverride: "Only blockers." },
			});

			await expect(
				duplicates({ prompt: "only  BLOCKERS." }),
			).resolves.toEqual([
				expect.objectContaining({ id: own, samePrompt: true }),
			]);
			await expect(
				duplicates({ prompt: "Summarize the week." }),
			).resolves.toEqual([
				expect.objectContaining({ id: unmarked, samePrompt: true }),
			]);
		});

		it("compares only the latest active or draft version, newest first", async () => {
			await seedReport({
				name: "Weekly status",
				minute: 1,
				sId: `renamed-${RUN_ID}`,
				version: 1,
			});
			await seedReport({
				name: "Renamed",
				minute: 2,
				sId: `renamed-${RUN_ID}`,
				version: 2,
			});
			const draft = await seedReport({
				name: "Weekly status",
				minute: 3,
				status: "DRAFT",
			});
			await seedReport({
				name: "Weekly status",
				minute: 4,
				status: "ARCHIVED",
			});
			const newest = await seedReport({
				name: "Weekly status",
				minute: 5,
			});

			const matches = await duplicates({ name: "Weekly status" });

			expect(matches.map((match) => match.id)).toEqual([newest, draft]);
		});

		it("never compares another organization's reports", async () => {
			await seedReport({
				name: "Weekly status",
				minute: 1,
				organizationId: OTHER_ORG_ID,
				templateId: OTHER_TEMPLATE_ID,
			});

			await expect(
				duplicates({
					name: "Weekly status",
					prompt: "Summarize the week.",
				}),
			).resolves.toEqual([]);
		});
	},
);
