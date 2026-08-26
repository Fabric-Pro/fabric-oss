/**
 * Real-Postgres integration tests for the security finding-grouping query
 * layer (`prisma/queries/projects/scan-grouping.ts`) — spec
 * `2026-07-01-security-finding-tickets`, Task Group 3.
 *
 * Covers (per spec §14.1 + this group's own task acceptance criteria):
 *   - `findOpenStoryByThemeTag` excludes `isFinal: true`-status stories and
 *     `DECLINED`/`CLOSED`-drafting-stage stories (§8.1's per-project-status
 *     grounding correction — "terminal" is a boolean flag on whichever
 *     status row a story points to, not a fixed enum).
 *   - `getLastKnownFingerprints` returns `[]` for a story with no prior
 *     `FINDINGS_GROUPED` activity, and the cumulative set for one with
 *     prior rows (§8.2).
 *   - Basic create/read/update round-trip for `ScanFindingGrouping` (Task 3.1).
 *   - `hasActiveScanFindingGrouping` (Task 3.2) and
 *     `getEligibleFindingsForGrouping` (Task 3.3) — the latter's exact
 *     "`[]`, never throw" contract is a CRITICAL CORRECTNESS requirement
 *     Task 2.8 depends on, so it's exercised directly here too.
 *   - `getProjectScanConfig` / `upsertProjectScanConfig` default + round-trip
 *     `agentTicketGenerationEnabled` (Task 3.6).
 *
 * Self-skips when DATABASE_URL is unset or points at the CI placeholder
 * (mirrors `backlog-dedup-guard.integration.test.ts`).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, type FeatureDraftingStage, Prisma } from "../prisma/client";
import {
	addDeclinedGroupingThemes,
	createScanFindingGrouping,
	findOpenStoryByThemeTag,
	type GroupingRunResults,
	getDeclinedGroupingThemes,
	getEligibleFindingsForGrouping,
	getLastKnownFingerprints,
	getLatestScanFindingGrouping,
	getScanFindingGrouping,
	hasActiveScanFindingGrouping,
	parseFingerprintsMetadata,
	removeDeclinedGroupingTheme,
	updateScanFindingGrouping,
} from "../prisma/queries/projects/scan-grouping";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-grouping-org-${RUN_ID}`;
const USER_ID = `test-grouping-user-${RUN_ID}`;

describe.skipIf(!hasReachableDatabaseUrl())(
	"scan-grouping queries (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Grouping Test User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Grouping Test Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterEach(async () => {
			// A single project delete cascades through every child row this
			// suite creates (ScanFindingGrouping, ProjectScanConfig,
			// ProjectScan → ScanFinding, ScanActivity, UserStory → StoryTag,
			// ProjectStoryStatus) — every one of those relations is declared
			// `onDelete: Cascade` from Project in schema.prisma.
			await db.project.deleteMany({ where: { userId: USER_ID } });
		});

		async function seedProject(name = "Grouping Test Project") {
			return db.project.create({
				data: { name, userId: USER_ID, organizationId: ORG_ID },
			});
		}

		async function seedStatus(
			projectId: string,
			opts: { name?: string; isFinal?: boolean } = {},
		) {
			return db.projectStoryStatus.create({
				data: {
					projectId,
					name: opts.name ?? "Backlog",
					color: "#94a3b8",
					order: 0,
					isDefault: !opts.isFinal,
					isFinal: opts.isFinal ?? false,
				},
			});
		}

		async function seedStory(
			projectId: string,
			statusId: string,
			opts: {
				identifier: string;
				title?: string;
				draftingStage?: FeatureDraftingStage;
			},
		) {
			return db.userStory.create({
				data: {
					projectId,
					statusId,
					identifier: opts.identifier,
					title: opts.title ?? `Story ${opts.identifier}`,
					kind: "BUG",
					priority: "P2_MEDIUM",
					createdById: USER_ID,
					source: "MANUAL",
					...(opts.draftingStage
						? { draftingStage: opts.draftingStage }
						: {}),
				},
			});
		}

		describe("findOpenStoryByThemeTag", () => {
			it("finds a non-terminal story tagged with the given theme value", async () => {
				const project = await seedProject();
				const status = await seedStatus(project.id);
				const story = await seedStory(project.id, status.id, {
					identifier: "B-1",
				});
				await db.storyTag.create({
					data: {
						storyId: story.id,
						value: "theme-security-abc-12345678",
					},
				});

				const found = await findOpenStoryByThemeTag(
					project.id,
					"theme-security-abc-12345678",
				);
				expect(found?.id).toBe(story.id);
			});

			it("excludes a story whose current status is isFinal: true", async () => {
				const project = await seedProject();
				const doneStatus = await seedStatus(project.id, {
					name: "Done",
					isFinal: true,
				});
				const story = await seedStory(project.id, doneStatus.id, {
					identifier: "B-2",
				});
				await db.storyTag.create({
					data: { storyId: story.id, value: "theme-final-excluded" },
				});

				const found = await findOpenStoryByThemeTag(
					project.id,
					"theme-final-excluded",
				);
				expect(found).toBeNull();
			});

			it.each(["DECLINED", "CLOSED"] as const)(
				"excludes a story whose draftingStage is %s",
				async (draftingStage) => {
					const project = await seedProject();
					const status = await seedStatus(project.id);
					const story = await seedStory(project.id, status.id, {
						identifier: `B-${draftingStage}`,
						draftingStage,
					});
					const tagValue = `theme-${draftingStage.toLowerCase()}`;
					await db.storyTag.create({
						data: { storyId: story.id, value: tagValue },
					});

					const found = await findOpenStoryByThemeTag(
						project.id,
						tagValue,
					);
					expect(found).toBeNull();
				},
			);

			it("is reusable verbatim for the fixed PREREQUISITE_ACCESS_TAG lookup (same function, different tagValue)", async () => {
				const project = await seedProject();
				const status = await seedStatus(project.id);
				const story = await seedStory(project.id, status.id, {
					identifier: "B-3",
				});
				await db.storyTag.create({
					data: {
						storyId: story.id,
						value: "theme-prerequisite-security-agent-access",
					},
				});

				const found = await findOpenStoryByThemeTag(
					project.id,
					"theme-prerequisite-security-agent-access",
				);
				expect(found?.id).toBe(story.id);
			});

			it("does not find a tag belonging to a story in a different project (tenant scoping)", async () => {
				const projectA = await seedProject("Project A");
				const projectB = await seedProject("Project B");
				const statusB = await seedStatus(projectB.id);
				const storyB = await seedStory(projectB.id, statusB.id, {
					identifier: "B-4",
				});
				await db.storyTag.create({
					data: { storyId: storyB.id, value: "theme-cross-project" },
				});

				const found = await findOpenStoryByThemeTag(
					projectA.id,
					"theme-cross-project",
				);
				expect(found).toBeNull();
			});

			it("returns null when no story carries the tag at all", async () => {
				const project = await seedProject();
				await seedStatus(project.id);
				const found = await findOpenStoryByThemeTag(
					project.id,
					"theme-does-not-exist",
				);
				expect(found).toBeNull();
			});
		});

		describe("getLastKnownFingerprints", () => {
			it("returns [] for a story with no prior FINDINGS_GROUPED activity (AC10 manual-ticket case)", async () => {
				const project = await seedProject();
				const status = await seedStatus(project.id);
				const story = await seedStory(project.id, status.id, {
					identifier: "B-5",
				});

				const fingerprints = await getLastKnownFingerprints(
					project.id,
					story.id,
				);
				expect(fingerprints).toEqual([]);
			});

			it("returns the latest row's cumulative fingerprint set (a single findFirst, not a merge across rows)", async () => {
				const project = await seedProject();
				const status = await seedStatus(project.id);
				const story = await seedStory(project.id, status.id, {
					identifier: "B-6",
				});

				await db.scanActivity.create({
					data: {
						projectId: project.id,
						storyId: story.id,
						type: "FINDINGS_GROUPED",
						userId: USER_ID,
						metadata: { fingerprints: ["fp1", "fp2"] },
						createdAt: new Date("2026-01-01T00:00:00Z"),
					},
				});
				await db.scanActivity.create({
					data: {
						projectId: project.id,
						storyId: story.id,
						type: "FINDINGS_GROUPED",
						userId: USER_ID,
						metadata: { fingerprints: ["fp1", "fp2", "fp3"] },
						createdAt: new Date("2026-01-02T00:00:00Z"),
					},
				});

				const fingerprints = await getLastKnownFingerprints(
					project.id,
					story.id,
				);
				expect([...fingerprints].sort()).toEqual(["fp1", "fp2", "fp3"]);
			});

			it("ignores ScanActivity rows of a different type", async () => {
				const project = await seedProject();
				const status = await seedStatus(project.id);
				const story = await seedStory(project.id, status.id, {
					identifier: "B-7",
				});

				await db.scanActivity.create({
					data: {
						projectId: project.id,
						storyId: story.id,
						type: "SCAN_COMPLETED",
						userId: USER_ID,
						metadata: { fingerprints: ["fp-wrong-type"] },
					},
				});

				expect(
					await getLastKnownFingerprints(project.id, story.id),
				).toEqual([]);
			});

			it("ignores ScanActivity rows belonging to a different story", async () => {
				const project = await seedProject();
				const status = await seedStatus(project.id);
				const storyA = await seedStory(project.id, status.id, {
					identifier: "B-8",
				});
				const storyB = await seedStory(project.id, status.id, {
					identifier: "B-9",
				});

				await db.scanActivity.create({
					data: {
						projectId: project.id,
						storyId: storyB.id,
						type: "FINDINGS_GROUPED",
						userId: USER_ID,
						metadata: { fingerprints: ["fp-story-b"] },
					},
				});

				expect(
					await getLastKnownFingerprints(project.id, storyA.id),
				).toEqual([]);
			});
		});

		describe("parseFingerprintsMetadata (pure helper)", () => {
			it("returns [] for null/undefined/non-object/array metadata", () => {
				expect(parseFingerprintsMetadata(null)).toEqual([]);
				expect(parseFingerprintsMetadata(undefined)).toEqual([]);
				expect(parseFingerprintsMetadata("nope")).toEqual([]);
				expect(parseFingerprintsMetadata(["a", "b"])).toEqual([]);
			});

			it("returns [] when fingerprints is missing or not an array", () => {
				expect(parseFingerprintsMetadata({})).toEqual([]);
				expect(
					parseFingerprintsMetadata({ fingerprints: "not-an-array" }),
				).toEqual([]);
			});

			it("drops non-string entries and keeps well-formed ones", () => {
				expect(
					parseFingerprintsMetadata({
						fingerprints: ["fp1", 2, null, "fp2"],
					}),
				).toEqual(["fp1", "fp2"]);
			});
		});

		describe("ScanFindingGrouping CRUD round-trip (Task 3.1)", () => {
			it("creates a PENDING row, reads it tenant-scoped, and updates it through to COMPLETED", async () => {
				const project = await seedProject();
				const grouping = await createScanFindingGrouping({
					projectId: project.id,
					userId: USER_ID,
					organizationId: ORG_ID,
				});
				expect(grouping.status).toBe("PENDING");
				expect(grouping.projectId).toBe(project.id);

				const fetched = await getScanFindingGrouping(
					grouping.id,
					project.id,
				);
				expect(fetched?.id).toBe(grouping.id);

				// Tenant-scoped: null (not throw) for a wrong-project id.
				const otherProject = await seedProject("Other Project");
				const wrongProject = await getScanFindingGrouping(
					grouping.id,
					otherProject.id,
				);
				expect(wrongProject).toBeNull();

				const running = await updateScanFindingGrouping(grouping.id, {
					status: "RUNNING",
					startedAt: new Date(),
				});
				expect(running.status).toBe("RUNNING");

				const results: GroupingRunResults = {
					createdThemes: [
						{
							category: "SECURITY",
							ruleSource: "OWASP Top 10 — A03:2021 Injection",
							themeKey: "theme-security-injection-12345678",
							findingCount: 2,
							storyId: "story-1",
							storyIdentifier: "B-100",
						},
					],
					updatedThemes: [],
					skippedThemes: [],
					failedThemes: [],
				};
				const completed = await updateScanFindingGrouping(grouping.id, {
					status: "COMPLETED",
					results,
					createdCount: 1,
					themeCount: 1,
					findingCount: 2,
					completedAt: new Date(),
				});
				expect(completed.status).toBe("COMPLETED");
				expect(completed.createdCount).toBe(1);
				expect(completed.results).toEqual(results);
			});

			it("getLatestScanFindingGrouping returns the most recently created run", async () => {
				const project = await seedProject();
				const older = await createScanFindingGrouping({
					projectId: project.id,
					userId: USER_ID,
				});
				const newer = await createScanFindingGrouping({
					projectId: project.id,
					userId: USER_ID,
				});
				// Force deterministic ordering rather than relying on real-clock
				// timing between two sequential creates.
				await db.scanFindingGrouping.update({
					where: { id: older.id },
					data: { createdAt: new Date("2020-01-01T00:00:00Z") },
				});
				await db.scanFindingGrouping.update({
					where: { id: newer.id },
					data: { createdAt: new Date("2030-01-01T00:00:00Z") },
				});

				const latest = await getLatestScanFindingGrouping(project.id);
				expect(latest?.id).toBe(newer.id);
			});

			it("getLatestScanFindingGrouping honors an optional status filter", async () => {
				const project = await seedProject();
				const completedOne = await createScanFindingGrouping({
					projectId: project.id,
					userId: USER_ID,
				});
				await updateScanFindingGrouping(completedOne.id, {
					status: "COMPLETED",
				});
				await db.scanFindingGrouping.update({
					where: { id: completedOne.id },
					data: { createdAt: new Date("2020-01-01T00:00:00Z") },
				});
				// A newer PENDING run exists, but the status filter should still
				// resolve to the COMPLETED one when asked for it explicitly.
				const pendingOne = await createScanFindingGrouping({
					projectId: project.id,
					userId: USER_ID,
				});
				await db.scanFindingGrouping.update({
					where: { id: pendingOne.id },
					data: { createdAt: new Date("2030-01-01T00:00:00Z") },
				});

				const latestCompleted = await getLatestScanFindingGrouping(
					project.id,
					{ status: "COMPLETED" },
				);
				expect(latestCompleted?.id).toBe(completedOne.id);
			});
		});

		describe("hasActiveScanFindingGrouping (Task 3.2)", () => {
			it("is false when there are no grouping rows", async () => {
				const project = await seedProject();
				expect(await hasActiveScanFindingGrouping(project.id)).toBe(
					false,
				);
			});

			it.each(["PENDING", "RUNNING"] as const)(
				"is true when a %s row exists",
				async (status) => {
					const project = await seedProject();
					const grouping = await createScanFindingGrouping({
						projectId: project.id,
						userId: USER_ID,
					});
					if (status !== "PENDING") {
						await updateScanFindingGrouping(grouping.id, {
							status,
						});
					}
					expect(await hasActiveScanFindingGrouping(project.id)).toBe(
						true,
					);
				},
			);

			it.each(["COMPLETED", "FAILED"] as const)(
				"is false when only a %s row exists",
				async (status) => {
					const project = await seedProject();
					const grouping = await createScanFindingGrouping({
						projectId: project.id,
						userId: USER_ID,
					});
					await updateScanFindingGrouping(grouping.id, { status });
					expect(await hasActiveScanFindingGrouping(project.id)).toBe(
						false,
					);
				},
			);
		});

		describe("getEligibleFindingsForGrouping (Task 3.3 — critical correctness for Task 2.8)", () => {
			it("returns [] (not throw) when the project has never completed a scan", async () => {
				const project = await seedProject();
				expect(
					await getEligibleFindingsForGrouping(project.id),
				).toEqual([]);
			});

			it("returns [] when the project's only scan is still PENDING/RUNNING", async () => {
				const project = await seedProject();
				await db.projectScan.create({
					data: {
						projectId: project.id,
						status: "RUNNING",
						userId: USER_ID,
					},
				});
				expect(
					await getEligibleFindingsForGrouping(project.id),
				).toEqual([]);
			});

			it("returns only OPEN findings from the latest COMPLETED scan", async () => {
				const project = await seedProject();
				const olderScan = await db.projectScan.create({
					data: {
						projectId: project.id,
						status: "COMPLETED",
						userId: USER_ID,
						createdAt: new Date("2020-01-01T00:00:00Z"),
						completedAt: new Date("2020-01-01T00:00:00Z"),
					},
				});
				await db.scanFinding.create({
					data: {
						scanId: olderScan.id,
						projectId: project.id,
						category: "SECURITY",
						severity: "HIGH",
						title: "Old scan finding — must be excluded",
						description: "d",
						remediation: "r",
						ruleSource: "OWASP Top 10 — A03:2021 Injection",
						status: "OPEN",
						userId: USER_ID,
					},
				});

				const newerScan = await db.projectScan.create({
					data: {
						projectId: project.id,
						status: "COMPLETED",
						userId: USER_ID,
						createdAt: new Date("2026-01-01T00:00:00Z"),
						completedAt: new Date("2026-01-01T00:00:00Z"),
					},
				});
				const openFinding = await db.scanFinding.create({
					data: {
						scanId: newerScan.id,
						projectId: project.id,
						category: "SECURITY",
						severity: "CRITICAL",
						title: "Open finding",
						description: "d",
						remediation: "r",
						ruleSource: "OWASP Top 10 — A03:2021 Injection",
						status: "OPEN",
						fingerprint: "fp-open",
						userId: USER_ID,
					},
				});
				await db.scanFinding.create({
					data: {
						scanId: newerScan.id,
						projectId: project.id,
						category: "ACCESSIBILITY",
						severity: "LOW",
						title: "Resolved finding — must be excluded",
						description: "d",
						remediation: "r",
						ruleSource: "WCAG 2.1 AA — 1.4.3 Contrast (Minimum)",
						status: "RESOLVED",
						userId: USER_ID,
					},
				});

				const findings = await getEligibleFindingsForGrouping(
					project.id,
				);
				expect(findings).toHaveLength(1);
				expect(findings[0]?.id).toBe(openFinding.id);
				expect(findings[0]?.fingerprint).toBe("fp-open");
			});
		});

		describe("declinedGroupingThemes store", () => {
			it("round-trips add + get + remove of a declined theme", async () => {
				const project = await seedProject();
				expect(await getDeclinedGroupingThemes(project.id)).toEqual([]);

				await addDeclinedGroupingThemes(
					project.id,
					{ userId: USER_ID, organizationId: ORG_ID },
					[
						{
							themeKey: "theme-security-generic-api-key-abcd1234",
							category: "SECURITY",
							ruleSource: "gitleaks:generic-api-key",
							declinedByUserId: USER_ID,
							declinedAt: "2026-07-03T00:00:00.000Z",
						},
					],
				);
				const afterAdd = await getDeclinedGroupingThemes(project.id);
				expect(afterAdd.map((t) => t.themeKey)).toEqual([
					"theme-security-generic-api-key-abcd1234",
				]);

				const removed = await removeDeclinedGroupingTheme(
					project.id,
					"theme-security-generic-api-key-abcd1234",
				);
				expect(removed?.themeKey).toBe(
					"theme-security-generic-api-key-abcd1234",
				);
				expect(await getDeclinedGroupingThemes(project.id)).toEqual([]);
			});

			it("dedupes by themeKey (last write wins) and no-ops an absent remove", async () => {
				const project = await seedProject();
				const tenant = { userId: USER_ID, organizationId: ORG_ID };
				await addDeclinedGroupingThemes(project.id, tenant, [
					{
						themeKey: "theme-a",
						category: "SECURITY",
						ruleSource: "r1",
						declinedAt: "2026-07-03T00:00:00.000Z",
					},
				]);
				await addDeclinedGroupingThemes(project.id, tenant, [
					{
						themeKey: "theme-a",
						category: "SECURITY",
						ruleSource: "r1-renamed",
						declinedAt: "2026-07-03T01:00:00.000Z",
					},
				]);
				const stored = await getDeclinedGroupingThemes(project.id);
				expect(stored).toHaveLength(1);
				expect(stored[0]?.ruleSource).toBe("r1-renamed");

				expect(
					await removeDeclinedGroupingTheme(
						project.id,
						"theme-missing",
					),
				).toBeNull();
			});
		});
	},
);
