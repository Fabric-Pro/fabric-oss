/**
 * Real-Postgres tests for Coding Instructions sets (spec 2026-11-11, "a set
 * is a folder"): a project's default set is created once, even under
 * concurrent first writes, gets the project's code repositories and never
 * the instructions repository; sets are created, renamed, reassigned and
 * deleted within their project. The partial unique indexes and the composite
 * foreign keys are the contract, so a mocked client cannot hold it.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database exec dotenv -c -e ../../.env.local -- vitest run __tests__/instruction-sets.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	createInstructionSet,
	DEFAULT_INSTRUCTION_SET_SLUG,
	db,
	deleteInstructionSet,
	ensureDefaultInstructionSet,
	findInstructionSet,
	InstructionSetError,
	listInstructionSets,
	updateInstructionSet,
	upsertInstructionRepositorySync,
} from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `instruction-sets-org-${RUN_ID}`;
const OWNER_ID = `instruction-sets-owner-${RUN_ID}`;

let projectId = "";
/** web, api: code repositories; instructions: the one Coding Instructions read. */
const integrations: Record<"web" | "api" | "instructions", string> = {
	web: "",
	api: "",
	instructions: "",
};

function owner() {
	return {
		projectId,
		organizationId: ORGANIZATION_ID,
		userId: OWNER_ID,
	};
}

async function assignedRepositoryIds(setId: string): Promise<string[]> {
	const rows = await db.projectInstructionSetRepository.findMany({
		where: { setId },
		select: { repositoryIntegrationId: true },
	});
	return rows.map((r) => r.repositoryIntegrationId).sort();
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"Coding Instructions sets: the default set (spec 2026-11-11)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: OWNER_ID,
					name: "Dev Example",
					email: `${OWNER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Instruction Sets Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			await db.member.create({
				data: {
					organizationId: ORGANIZATION_ID,
					userId: OWNER_ID,
					role: "owner",
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Instruction Sets Integration",
					userId: OWNER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			projectId = project.id;
			for (const key of Object.keys(integrations) as Array<
				keyof typeof integrations
			>) {
				const row = await db.projectRepositoryIntegration.create({
					data: {
						projectId,
						provider: "GITHUB",
						authMethod: "OAUTH",
						repositoryUrl: `https://github.com/example-org/${key}-${RUN_ID}`,
						repositoryOwner: "example-org",
						repositoryName: `${key}-${RUN_ID}`,
					},
				});
				integrations[key] = row.id;
			}
		});

		afterEach(async () => {
			await db.projectInstructionRepositorySyncRun.deleteMany({
				where: { projectId },
			});
			await db.projectInstructionRepositorySync.deleteMany({
				where: { projectId },
			});
			await db.projectInstructionSet.deleteMany({ where: { projectId } });
			await db.$transaction([
				db.$executeRawUnsafe("SET LOCAL app.audit_allow_delete = 'on'"),
				db.$executeRaw`DELETE FROM "audit_log" WHERE "organizationId" = ${ORGANIZATION_ID}`,
			]);
		});

		afterAll(async () => {
			// Delete by the exact ids this run created, never by pattern.
			if (projectId) {
				await db.project.deleteMany({ where: { id: projectId } });
			}
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({ where: { id: OWNER_ID } });
		});

		it("creates the default set once and gives it every code repository", async () => {
			const first = await ensureDefaultInstructionSet(db, owner());
			const again = await ensureDefaultInstructionSet(db, owner());
			expect(again).toBe(first);

			const sets = await db.projectInstructionSet.findMany({
				where: { projectId },
			});
			expect(sets).toHaveLength(1);
			expect(sets[0]).toMatchObject({
				id: first,
				slug: DEFAULT_INSTRUCTION_SET_SLUG,
				isDefault: true,
				organizationId: ORGANIZATION_ID,
			});
			// No sync yet: every connected repository is a code repository.
			expect(await assignedRepositoryIds(first)).toEqual(
				Object.values(integrations).sort(),
			);
		});

		it("never assigns a repository Coding Instructions are read from", async () => {
			await upsertInstructionRepositorySync({
				...owner(),
				repositoryIntegrationId: integrations.instructions,
				ref: "main",
				rootPath: "",
				automatic: true,
			});
			const setId = await ensureDefaultInstructionSet(db, owner());
			expect(await assignedRepositoryIds(setId)).toEqual(
				[integrations.web, integrations.api].sort(),
			);
		});

		it("concurrent first writes agree on one default set", async () => {
			const ids = await Promise.all(
				Array.from({ length: 6 }, () =>
					ensureDefaultInstructionSet(db, owner()),
				),
			);
			expect(new Set(ids).size).toBe(1);
			expect(
				await db.projectInstructionSet.count({ where: { projectId } }),
			).toBe(1);
		});

		it("refuses a second default set and a repository of another project", async () => {
			const setId = await ensureDefaultInstructionSet(db, owner());
			await expect(
				db.projectInstructionSet.create({
					data: {
						...owner(),
						name: "Second",
						slug: "second",
						isDefault: true,
					},
				}),
			).rejects.toThrow();
			const otherProject = await db.project.create({
				data: {
					name: "Instruction Sets Other",
					userId: OWNER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			try {
				const foreign = await db.projectRepositoryIntegration.create({
					data: {
						projectId: otherProject.id,
						provider: "GITHUB",
						authMethod: "OAUTH",
						repositoryUrl: `https://github.com/example-org/foreign-${RUN_ID}`,
						repositoryOwner: "example-org",
						repositoryName: `foreign-${RUN_ID}`,
					},
				});
				await expect(
					db.projectInstructionSetRepository.create({
						data: {
							setId,
							repositoryIntegrationId: foreign.id,
							projectId,
							organizationId: ORGANIZATION_ID,
							userId: OWNER_ID,
						},
					}),
				).rejects.toThrow();
			} finally {
				await db.project.deleteMany({ where: { id: otherProject.id } });
			}
		});

		async function refusal(promise: Promise<unknown>): Promise<string> {
			const error = await promise.then(
				() => null,
				(e: unknown) => e,
			);
			expect(error).toBeInstanceOf(InstructionSetError);
			return (error as InstructionSetError).code;
		}

		it("creates a set beside the default one, with its own repositories", async () => {
			const created = await createInstructionSet({
				...owner(),
				name: "  Mobile   apps ",
				repositoryIntegrationIds: [integrations.web, integrations.web],
			});
			expect(created).toMatchObject({
				name: "Mobile apps",
				slug: "mobile-apps",
				isDefault: false,
				repositoryIntegrationIds: [integrations.web],
			});
			const sets = await listInstructionSets(projectId);
			expect(sets.map((s) => [s.slug, s.isDefault])).toEqual([
				[DEFAULT_INSTRUCTION_SET_SLUG, true],
				["mobile-apps", false],
			]);
			// D1: a repository may be in several sets.
			expect(sets[0]?.repositoryIntegrationIds).toContain(
				integrations.web,
			);
		});

		it("refuses a taken or reserved slug, an empty name and repositories it may not cover", async () => {
			await createInstructionSet({
				...owner(),
				name: "Backend",
				repositoryIntegrationIds: [],
			});
			expect(
				await refusal(
					createInstructionSet({
						...owner(),
						name: "backend!",
						repositoryIntegrationIds: [],
					}),
				),
			).toBe("SLUG_TAKEN");
			expect(
				await refusal(
					createInstructionSet({
						...owner(),
						name: "Default",
						repositoryIntegrationIds: [],
					}),
				),
			).toBe("SLUG_TAKEN");
			expect(
				await refusal(
					createInstructionSet({
						...owner(),
						name: "  ",
						repositoryIntegrationIds: [],
					}),
				),
			).toBe("INVALID_SET_NAME");
			expect(
				await refusal(
					createInstructionSet({
						...owner(),
						name: "Elsewhere",
						repositoryIntegrationIds: ["not-a-repository"],
					}),
				),
			).toBe("REPOSITORY_NOT_FOUND");

			await upsertInstructionRepositorySync({
				...owner(),
				repositoryIntegrationId: integrations.instructions,
				ref: "main",
				rootPath: "",
				automatic: true,
			});
			expect(
				await refusal(
					createInstructionSet({
						...owner(),
						name: "Sources",
						repositoryIntegrationIds: [integrations.instructions],
					}),
				),
			).toBe("REPOSITORY_IS_INSTRUCTIONS_SOURCE");
		});

		it("renames and reassigns a set, keeping its slug", async () => {
			const created = await createInstructionSet({
				...owner(),
				name: "Web",
				repositoryIntegrationIds: [integrations.web],
			});
			const { set, before } = await updateInstructionSet({
				...owner(),
				setId: created.id,
				name: "Web and API",
				repositoryIntegrationIds: [integrations.api],
			});
			expect(before.repositoryIntegrationIds).toEqual([integrations.web]);
			expect(set).toMatchObject({
				name: "Web and API",
				slug: "web",
				repositoryIntegrationIds: [integrations.api],
			});
		});

		it("deletes a set softly, freeing its slug, but never the default set", async () => {
			const created = await createInstructionSet({
				...owner(),
				name: "Legacy",
				repositoryIntegrationIds: [integrations.api],
			});
			await deleteInstructionSet({ projectId, setId: created.id });
			expect(
				await findInstructionSet(projectId, { id: created.id }),
			).toBeNull();
			const row = await db.projectInstructionSet.findUniqueOrThrow({
				where: { id: created.id },
			});
			expect(row.deletedAt).not.toBeNull();
			expect(
				await db.projectInstructionSetRepository.count({
					where: { setId: created.id },
				}),
			).toBe(0);
			// The slug is free again.
			const again = await createInstructionSet({
				...owner(),
				name: "Legacy",
				repositoryIntegrationIds: [],
			});
			expect(again.id).not.toBe(created.id);

			const defaultSet = await findInstructionSet(projectId, {
				slug: DEFAULT_INSTRUCTION_SET_SLUG,
			});
			// The default set is the root; a deleted set's folder stays out of
			// it, since its files are still in git.
			expect(defaultSet).toMatchObject({
				folder: "",
				excludedFolders: ["instructions/legacy/"],
			});
			expect(again).toMatchObject({
				folder: "instructions/legacy/",
				excludedFolders: [],
			});
			expect(
				await refusal(
					deleteInstructionSet({
						projectId,
						setId: defaultSet?.id ?? "",
					}),
				),
			).toBe("DEFAULT_SET_UNDELETABLE");
		});

		it("never reaches a set of another project", async () => {
			const created = await createInstructionSet({
				...owner(),
				name: "Mine",
				repositoryIntegrationIds: [],
			});
			expect(
				await refusal(
					deleteInstructionSet({
						projectId: "another-project",
						setId: created.id,
					}),
				),
			).toBe("SET_NOT_FOUND");
			expect(
				await refusal(
					updateInstructionSet({
						...owner(),
						projectId: "another-project",
						setId: created.id,
						name: "Theirs",
					}),
				),
			).toBe("SET_NOT_FOUND");
		});
	},
);
