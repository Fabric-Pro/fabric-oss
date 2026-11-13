/**
 * Coding Instructions sets (spec 2026-11-11, "a set is a folder").
 *
 * A project with no sets is read as today: its instructions apply to every
 * code repository. The default set is created the moment a person adds a
 * second set, holding the project's existing instructions (the source's root
 * minus the other sets' folders) and every code repository connected then, so
 * adding a set never takes instructions away from a repository by itself.
 */

import type { db, Prisma } from "../client";

/** The slug of the set every project starts with. */
export const DEFAULT_INSTRUCTION_SET_SLUG = "default";
/** The default set's name until a person renames it. */
const DEFAULT_INSTRUCTION_SET_NAME = "Coding Instructions";

type Client = Prisma.TransactionClient | typeof db;

/**
 * The project's default set id, creating the set when the project has none.
 *
 * Safe under concurrency: the insert skips a conflict with the partial unique
 * index `project_instruction_set_one_default_key`, and the read that follows
 * sees whichever insert won. A newly created set gets the project's code
 * repositories, as the backfill gives them: every connected repository except
 * one Coding Instructions read from.
 */
export async function ensureDefaultInstructionSet(
	client: Client,
	input: {
		projectId: string;
		organizationId: string;
		userId: string;
	},
): Promise<string> {
	const existing = await findDefaultInstructionSetId(client, input.projectId);
	if (existing) {
		return existing;
	}
	const { count } = await client.projectInstructionSet.createMany({
		data: [
			{
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.userId,
				name: DEFAULT_INSTRUCTION_SET_NAME,
				slug: DEFAULT_INSTRUCTION_SET_SLUG,
				isDefault: true,
			},
		],
		skipDuplicates: true,
	});
	const setId = await findDefaultInstructionSetId(client, input.projectId);
	if (!setId) {
		// Only a live non-default set holding the slug could cause this, and
		// `default` is refused as a set's slug.
		throw new Error(
			"The project's default Coding Instructions set could not be created",
		);
	}
	if (count === 1) {
		await assignCodeRepositoriesToSet(client, {
			setId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
		});
	}
	return setId;
}

async function findDefaultInstructionSetId(
	client: Client,
	projectId: string,
): Promise<string | null> {
	const row = await client.projectInstructionSet.findFirst({
		where: { projectId, isDefault: true },
		select: { id: true },
	});
	return row?.id ?? null;
}

async function assignCodeRepositoriesToSet(
	client: Client,
	input: {
		setId: string;
		projectId: string;
		organizationId: string;
		userId: string;
	},
): Promise<void> {
	const syncs = await client.projectInstructionRepositorySync.findMany({
		where: { projectId: input.projectId },
		select: { repositoryIntegrationId: true },
	});
	const excluded = new Set(syncs.map((s) => s.repositoryIntegrationId));
	const repositories = await client.projectRepositoryIntegration.findMany({
		where: { projectId: input.projectId },
		select: { id: true },
	});
	const data = repositories
		.filter((r) => !excluded.has(r.id))
		.map((r) => ({
			setId: input.setId,
			repositoryIntegrationId: r.id,
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
		}));
	if (data.length > 0) {
		await client.projectInstructionSetRepository.createMany({
			data,
			skipDuplicates: true,
		});
	}
}
