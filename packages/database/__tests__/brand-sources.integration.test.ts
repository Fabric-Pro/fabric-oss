/**
 * Real-Postgres integration test for the brand source rows (Fizzy #2946).
 *
 * What a mocked client cannot show:
 *  1. the migration's CHECK constraints refuse every shape the writers never
 *     produce (written as raw SQL on the base client, so the claim holds
 *     whoever the writer is), and accept a punycode website;
 *  2. two concurrent website fetch starts are decided one after the other
 *     under the Brand kit row lock: one starts, the other joins;
 *  3. two first Brand kit saves: one inserts, the other conflicts;
 *  4. two overlapping export records: the export that read its brand later
 *     keeps the row, whichever writes last;
 *  5. confirming a suggestion re-checks, inside the write, that it is still
 *     the stored attempt: a replaced suggestion makes the confirm stale.
 *
 * Requires the brand sources migration on the target database. Self-skips
 * without a reachable DATABASE_URL.
 *
 * Run with: pnpm --filter @repo/database test:integration
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import { upsertBrandKit } from "../prisma/queries/brand-kit";
import { startBrandSiteFetch } from "../prisma/queries/brand-site-fetch";
import { recordProposalExportBrand } from "../prisma/queries/projects/proposal-export-brand";
import { confirmRecipientBrand } from "../prisma/queries/projects/recipient-brand";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN = `${Date.now()}-${process.pid}`;
const id = (name: string) => `brand-it-${name}-${RUN}`;

const USER = id("user");
/** Holds the rows the CHECK cases update. */
const ORG_CHECKS = id("org-checks");
/** Holds a Brand kit with a website, for the concurrent fetch starts. */
const ORG_FETCH = id("org-fetch");
/** Starts with no Brand kit, for the two first saves. */
const ORG_FIRST_SAVE = id("org-first-save");
const ORG_OTHER = id("org-other");
const PROJECT = id("project");
const DOCUMENT = id("document");
const ORGS = [ORG_CHECKS, ORG_FETCH, ORG_FIRST_SAVE, ORG_OTHER];

/** The database's refusal, as text, or null when the write went through. */
async function refusal(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run();
		return null;
	} catch (error) {
		const err = error as Error & { meta?: unknown };
		return `${err.message} ${JSON.stringify(err.meta ?? {})}`;
	}
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"Brand source rows (real Postgres)",
	() => {
		beforeAll(async () => {
			const present = await db.$queryRaw<{ name: string | null }[]>`
				SELECT to_regclass('public.organization_brand_site_fetch')::text AS name`;
			if (!present[0]?.name) {
				throw new Error(
					"organization_brand_site_fetch is missing: apply the *_brand_sources migration (prisma migrate deploy) to this database first",
				);
			}

			const now = new Date();
			await db.user.create({
				data: {
					id: USER,
					name: "Example Admin",
					email: `${USER}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			for (const organizationId of ORGS) {
				await db.organization.create({
					data: {
						id: organizationId,
						name: `Example ${organizationId}`,
						slug: organizationId,
						createdAt: now,
					},
				});
			}
			await db.project.create({
				data: {
					id: PROJECT,
					name: "Example project",
					userId: USER,
					organizationId: ORG_CHECKS,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			await db.projectDocument.create({
				data: {
					id: DOCUMENT,
					projectId: PROJECT,
					type: "PROPOSAL",
					title: "Example proposal",
					content: "# Example\n\nBody.",
					userId: USER,
					organizationId: ORG_CHECKS,
				},
			});
			for (const organizationId of [ORG_CHECKS, ORG_FETCH]) {
				await db.organizationBrandKit.create({
					data: {
						organizationId,
						accentColors: [],
						website: "https://example.com",
						updatedById: USER,
					},
				});
			}
			await db.organizationBrandSiteFetch.create({
				data: {
					organizationId: ORG_CHECKS,
					website: "https://example.com",
					requestId: id("req-check"),
					status: "SUCCEEDED",
					requestedById: USER,
					requestedAt: now,
				},
			});
			await db.projectRecipientBrandSuggestion.create({
				data: {
					projectId: PROJECT,
					organizationId: ORG_CHECKS,
					website: "https://client.example.com",
					requestId: id("req-suggestion"),
					status: "SUCCEEDED",
					requestedById: USER,
					requestedAt: now,
				},
			});
		});

		afterAll(async () => {
			// The project cascades to its document, suggestion and export
			// record; organizations cascade to their Brand kits and fetches.
			await db.project.deleteMany({ where: { id: PROJECT } });
			await db.organization.deleteMany({ where: { id: { in: ORGS } } });
			await db.user.deleteMany({ where: { id: USER } });
		});

		describe("CHECK constraints", () => {
			const pendingHero = `organization-brand/${ORG_CHECKS}/pending/hero.png`;
			const otherOrgFont = `organization-brand/${ORG_OTHER}/fonts/font.woff2`;
			const otherProjectLogo =
				"project-brand/example-other-project/recipient-brand/suggested/logo.png";

			it.each([
				[
					"a Brand kit website with an underscore",
					"organization_brand_kit_website_check",
					() => db.$executeRaw`
						UPDATE "organization_brand_kit" SET "website" = 'https://my_site.example.com'
						WHERE "organizationId" = ${ORG_CHECKS}`,
				],
				[
					"a website fetch for a website with an underscore",
					"organization_brand_site_fetch_website_check",
					() => db.$executeRaw`
						UPDATE "organization_brand_site_fetch" SET "website" = 'https://my_site.example.com'
						WHERE "organizationId" = ${ORG_CHECKS}`,
				],
				[
					"a recipient fetch for a website with an underscore",
					"project_recipient_brand_suggestion_website_check",
					() => db.$executeRaw`
						UPDATE "project_recipient_brand_suggestion" SET "resultWebsite" = 'https://my_site.example.com'
						WHERE "projectId" = ${PROJECT}`,
				],
				[
					"a FAILED attempt without a failure code",
					"organization_brand_site_fetch_status_check",
					() => db.$executeRaw`
						UPDATE "organization_brand_site_fetch" SET "status" = 'FAILED', "failureCode" = NULL
						WHERE "organizationId" = ${ORG_CHECKS}`,
				],
				[
					"a RUNNING attempt with a failure code",
					"project_recipient_brand_suggestion_status_check",
					() => db.$executeRaw`
						UPDATE "project_recipient_brand_suggestion" SET "status" = 'RUNNING', "failureCode" = 'blocked'
						WHERE "projectId" = ${PROJECT}`,
				],
				[
					"a fourth fetched accent",
					"organization_brand_site_fetch_colors_check",
					() => db.$executeRaw`
						UPDATE "organization_brand_site_fetch"
						SET "accentColors" = ARRAY['#111111', '#222222', '#333333', '#444444']
						WHERE "organizationId" = ${ORG_CHECKS}`,
				],
				[
					"a font key of another organization",
					"organization_brand_kit_font_key_check",
					() => db.$executeRaw`
						UPDATE "organization_brand_kit"
						SET "displayFontFamily" = 'Example Display', "displayFontKey" = ${otherOrgFont}
						WHERE "organizationId" = ${ORG_CHECKS}`,
				],
				[
					"a hero key under pending/",
					"organization_brand_kit_hero_key_check",
					() => db.$executeRaw`
						UPDATE "organization_brand_kit" SET "heroKey" = ${pendingHero}
						WHERE "organizationId" = ${ORG_CHECKS}`,
				],
				[
					"a suggested logo key of another project",
					"project_recipient_brand_suggestion_logo_key_check",
					() => db.$executeRaw`
						UPDATE "project_recipient_brand_suggestion" SET "logoKey" = ${otherProjectLogo}
						WHERE "projectId" = ${PROJECT}`,
				],
				[
					"a token hash without its version prefix",
					"project_document_export_brand_fields_check",
					() => db.$executeRaw`
						INSERT INTO "project_document_export_brand"
							("id", "documentId", "projectId", "organizationId", "themeTokenHash",
							 "format", "exportedAt", "updatedAt")
						VALUES (${id("bad-hash")}, ${DOCUMENT}, ${PROJECT}, ${ORG_CHECKS},
							'0123456789abcdef', 'PDF', NOW(), NOW())`,
				],
			])("refuses %s", async (_label, constraint, write) => {
				// Named, so a refusal for an unrelated reason cannot pass.
				expect(await refusal(write)).toContain(constraint);
			});

			it("accepts a punycode website", async () => {
				const punycode = "https://xn--bcher-kva.example";
				expect(
					await refusal(
						() => db.$executeRaw`
							UPDATE "organization_brand_kit" SET "website" = ${punycode}
							WHERE "organizationId" = ${ORG_CHECKS}`,
					),
				).toBeNull();
				expect(
					await refusal(
						() => db.$executeRaw`
							UPDATE "organization_brand_site_fetch" SET "website" = ${punycode}
							WHERE "organizationId" = ${ORG_CHECKS}`,
					),
				).toBeNull();
				const kit = await db.organizationBrandKit.findUniqueOrThrow({
					where: { organizationId: ORG_CHECKS },
					select: { website: true },
				});
				expect(kit.website).toBe(punycode);
			});
		});

		it("decides two concurrent fetch starts one after the other: one starts, one joins", async () => {
			const requestedAt = new Date();
			const start = (requestId: string) =>
				startBrandSiteFetch({
					organizationId: ORG_FETCH,
					website: "https://example.com",
					requestId,
					requestedById: USER,
					requestedAt,
				});

			const results = await Promise.all([
				start(id("req-a")),
				start(id("req-b")),
			]);

			expect([...results].sort()).toEqual(["joined", "started"]);
			const row = await db.organizationBrandSiteFetch.findUniqueOrThrow({
				where: { organizationId: ORG_FETCH },
				select: { requestId: true, status: true },
			});
			expect(row.status).toBe("RUNNING");
			expect([id("req-a"), id("req-b")]).toContain(row.requestId);

			// A refused automatic start inside the window joins it too.
			expect(
				await startBrandSiteFetch({
					organizationId: ORG_FETCH,
					website: "https://example.com",
					requestId: id("req-refused"),
					requestedById: USER,
					requestedAt: new Date(),
					failureCode: "rate_limited",
				}),
			).toBe("joined");
		});

		it("applies one of two first Brand kit saves and conflicts the other", async () => {
			const save = (accent: string) =>
				upsertBrandKit({
					organizationId: ORG_FIRST_SAVE,
					accentColors: [accent],
					expectedVersion: 0,
					updatedById: USER,
				});

			const results = await Promise.all([
				save("#111111"),
				save("#222222"),
			]);

			expect(results.map((result) => result.outcome).sort()).toEqual([
				"applied",
				"conflict",
			]);
			const kit = await db.organizationBrandKit.findUniqueOrThrow({
				where: { organizationId: ORG_FIRST_SAVE },
				select: { version: true, accentColors: true },
			});
			expect(kit.version).toBe(1);
			const applied = results.find(
				(result) => result.outcome === "applied",
			);
			expect(
				applied?.outcome === "applied" && applied.brandKit.accentColors,
			).toEqual(kit.accentColors);
		});

		it("confirms a suggestion only while it is still the stored attempt for the row's website", async () => {
			const website = "https://client.example.com";
			await db.projectRecipientBrand.create({
				data: {
					projectId: PROJECT,
					organizationId: ORG_CHECKS,
					name: "Example Client",
					website,
					colors: ["#b91c1c"],
					version: 1,
					updatedById: USER,
				},
			});
			await db.projectRecipientBrandSuggestion.update({
				where: { projectId: PROJECT },
				data: {
					requestId: id("req-shown"),
					status: "SUCCEEDED",
					failureCode: null,
					website,
					resultWebsite: website,
					colors: ["#1e2327"],
				},
			});
			const confirm = (requestId: string, expectedVersion: number) =>
				confirmRecipientBrand({
					projectId: PROJECT,
					organizationId: ORG_CHECKS,
					expectedVersion,
					name: "Example Client",
					website,
					colors: ["#1e2327"],
					updatedById: USER,
					suggestion: { requestId },
				});

			// An attempt the editor did not see: refused, nothing written.
			expect(await confirm(id("req-other"), 1)).toEqual({
				outcome: "stale",
			});
			expect(
				(
					await db.projectRecipientBrand.findUniqueOrThrow({
						where: { projectId: PROJECT },
						select: { version: true, colors: true },
					})
				).colors,
			).toEqual(["#b91c1c"]);

			// The attempt the editor saw: applied under the version check.
			expect(await confirm(id("req-shown"), 1)).toMatchObject({
				outcome: "applied",
				version: 2,
			});

			// A newer fetch replaced the suggestion: the same confirm is stale.
			await db.projectRecipientBrandSuggestion.update({
				where: { projectId: PROJECT },
				data: { requestId: id("req-newer"), status: "RUNNING" },
			});
			expect(await confirm(id("req-shown"), 2)).toEqual({
				outcome: "stale",
			});
		});

		describe("the export record", () => {
			const EARLIER = new Date("2026-10-22T12:00:00.123Z");
			const LATER = new Date("2026-10-22T12:00:05.456Z");
			const record = (exportedAt: Date, themeTokenHash: string) =>
				recordProposalExportBrand({
					documentId: DOCUMENT,
					projectId: PROJECT,
					organizationId: ORG_CHECKS,
					themeTokenHash,
					format: "PDF",
					exportedAt,
				});
			const stored = () =>
				db.projectDocumentExportBrand.findUniqueOrThrow({
					where: { documentId: DOCUMENT },
					select: { themeTokenHash: true, exportedAt: true },
				});

			it("keeps the later-started export when the earlier one writes last", async () => {
				expect(await record(LATER, "t2:bbbbbbbbbbbbbbbb")).toBe(true);
				expect(await record(EARLIER, "t2:aaaaaaaaaaaaaaaa")).toBe(
					false,
				);

				expect(await stored()).toEqual({
					themeTokenHash: "t2:bbbbbbbbbbbbbbbb",
					exportedAt: LATER,
				});
			});

			it("replaces the record with an export that started later", async () => {
				const latest = new Date(LATER.getTime() + 1000);
				expect(await record(latest, "t2:cccccccccccccccc")).toBe(true);

				expect(await stored()).toEqual({
					themeTokenHash: "t2:cccccccccccccccc",
					exportedAt: latest,
				});
			});

			it("keeps the later-started of two exports writing at once", async () => {
				const base = Date.now() + 60_000;
				const first = new Date(base);
				const second = new Date(base + 1000);

				await Promise.all([
					record(second, "t2:eeeeeeeeeeeeeeee"),
					record(first, "t2:dddddddddddddddd"),
				]);

				expect(await stored()).toEqual({
					themeTokenHash: "t2:eeeeeeeeeeeeeeee",
					exportedAt: second,
				});
				expect(
					await db.projectDocumentExportBrand.count({
						where: { documentId: DOCUMENT },
					}),
				).toBe(1);
			});
		});
	},
);
