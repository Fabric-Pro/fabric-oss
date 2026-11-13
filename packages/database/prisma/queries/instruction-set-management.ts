/**
 * Managing a project's Coding Instructions sets (spec 2026-11-11 §4.1, §4.5):
 * list, create, rename, assign code repositories, delete. One implementation
 * shared by the API, CLI, MCP and the Fabric Agent.
 *
 * Callers resolve project access (read: INSTRUCTION_READ, write:
 * INSTRUCTION_UPDATE) and the hosting organization before calling in; every
 * query here is narrowed by `projectId`, so a set or repository of another
 * project is "not found", never touched.
 *
 * A set is a folder (decision 2026-11-12): sync, versions, proposals and
 * review stay one per project, over the whole instructions source. A set's
 * files are `instructions/<slug>/`; the default set's are the source's root
 * minus every other set's folder, a deleted set's included (its files stay
 * in git, D7, and must not leak into the default set). Consumers (the CLI
 * plugin, MCP reads) apply `folder` and `excludedFolders` with
 * `pathInInstructionSet`.
 */

import { db, Prisma } from "../client";
import {
	DEFAULT_INSTRUCTION_SET_SLUG,
	ensureDefaultInstructionSet,
} from "./instruction-sets";

export type InstructionSetErrorCode =
	| "SET_NOT_FOUND"
	| "INVALID_SET_NAME"
	| "SLUG_TAKEN"
	| "DEFAULT_SET_UNDELETABLE"
	| "REPOSITORY_NOT_FOUND"
	| "REPOSITORY_IS_INSTRUCTIONS_SOURCE";

/** A refusal callers turn into their transport's error, keeping the code. */
export class InstructionSetError extends Error {
	constructor(
		readonly code: InstructionSetErrorCode,
		message: string,
		readonly details?: { repositoryIntegrationIds?: string[] },
	) {
		super(message);
		this.name = "InstructionSetError";
	}
}

export type InstructionSetView = {
	id: string;
	name: string;
	slug: string;
	isDefault: boolean;
	repositoryIntegrationIds: string[];
	/** The set's folder in the instructions source: `instructions/<slug>/`, or `""` for the default set (the root). */
	folder: string;
	/** Folders under `folder` that belong to other sets: every other set's, for the default set; none otherwise. */
	excludedFolders: string[];
	createdAt: Date;
	updatedAt: Date;
};

/** The parent folder every non-default set's folder sits in. */
export const INSTRUCTION_SETS_FOLDER = "instructions";

/** A set's folder in the instructions source, with a trailing slash; `""` for the default set. */
export function instructionSetFolder(set: {
	slug: string;
	isDefault: boolean;
}): string {
	return set.isDefault ? "" : `${INSTRUCTION_SETS_FOLDER}/${set.slug}/`;
}

/**
 * Where a file of the instructions source sits within a set: its path
 * relative to the set's folder, or null when the file is not the set's.
 * Without a set (a project that has none) every file is its own.
 */
export function pathInInstructionSet(
	path: string,
	set: { folder: string; excludedFolders: readonly string[] } | null,
): string | null {
	if (!set) {
		return path;
	}
	if (!path.startsWith(set.folder)) {
		return null;
	}
	if (set.excludedFolders.some((folder) => path.startsWith(folder))) {
		return null;
	}
	return path.slice(set.folder.length);
}

const NAME_MAX = 80;
const SLUG_MAX = 40;

/**
 * The slug a name gets: lowercase letters, digits and single dashes, 2–40
 * long. Null when nothing usable is left. Stable once given: a rename keeps
 * the slug, because the set's folders and plugin are named after it.
 */
export function instructionSetSlugFor(name: string): string | null {
	const slug = name
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, SLUG_MAX)
		.replace(/-+$/g, "");
	return slug.length >= 2 ? slug : null;
}

const setSelect = {
	id: true,
	name: true,
	slug: true,
	isDefault: true,
	createdAt: true,
	updatedAt: true,
	repositories: {
		select: { repositoryIntegrationId: true },
		orderBy: { createdAt: "asc" },
	},
} satisfies Prisma.ProjectInstructionSetSelect;

type SetRow = Prisma.ProjectInstructionSetGetPayload<{
	select: typeof setSelect;
}>;

function view(row: SetRow, otherSlugs: readonly string[]): InstructionSetView {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		isDefault: row.isDefault,
		repositoryIntegrationIds: row.repositories.map(
			(r) => r.repositoryIntegrationId,
		),
		folder: instructionSetFolder(row),
		excludedFolders: row.isDefault
			? [...new Set(otherSlugs)]
					.sort()
					.map((slug) =>
						instructionSetFolder({ slug, isDefault: false }),
					)
			: [],
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** Every non-default set's slug the project ever had, deleted ones included. */
async function otherSetSlugs(
	client: Prisma.TransactionClient | typeof db,
	projectId: string,
): Promise<string[]> {
	const rows = await client.projectInstructionSet.findMany({
		where: { projectId, isDefault: false },
		select: { slug: true },
	});
	return rows.map((r) => r.slug);
}

/** The project's live sets, the default first, then by name. */
export async function listInstructionSets(
	projectId: string,
): Promise<InstructionSetView[]> {
	const [rows, others] = await Promise.all([
		db.projectInstructionSet.findMany({
			where: { projectId, deletedAt: null },
			select: setSelect,
			orderBy: [{ isDefault: "desc" }, { name: "asc" }],
		}),
		otherSetSlugs(db, projectId),
	]);
	return rows.map((row) => view(row, others));
}

/** One live set of the project, by id or slug; null when there is none. */
export async function findInstructionSet(
	projectId: string,
	ref: { id: string } | { slug: string },
): Promise<InstructionSetView | null> {
	const row = await db.projectInstructionSet.findFirst({
		where: { projectId, deletedAt: null, ...ref },
		select: setSelect,
	});
	return row ? view(row, await otherSetSlugs(db, projectId)) : null;
}

function cleanName(name: string): string {
	const trimmed = name.trim().replace(/\s+/g, " ");
	if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
		throw new InstructionSetError(
			"INVALID_SET_NAME",
			`Give the set a name of 1–${NAME_MAX} characters.`,
		);
	}
	return trimmed;
}

/**
 * The repositories a set may cover: the project's connected repositories,
 * except one Coding Instructions are read from (D3/D8: instructions live in
 * their own repository, never in a code repository).
 */
async function checkCodeRepositories(
	tx: Prisma.TransactionClient,
	projectId: string,
	ids: string[],
): Promise<string[]> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) {
		return unique;
	}
	const found = await tx.projectRepositoryIntegration.findMany({
		where: { projectId, id: { in: unique } },
		select: { id: true },
	});
	const known = new Set(found.map((r) => r.id));
	const missing = unique.filter((id) => !known.has(id));
	if (missing.length > 0) {
		throw new InstructionSetError(
			"REPOSITORY_NOT_FOUND",
			"Some repositories are not connected to this project.",
			{ repositoryIntegrationIds: missing },
		);
	}
	const sources = await tx.projectInstructionRepositorySync.findMany({
		where: { projectId, repositoryIntegrationId: { in: unique } },
		select: { repositoryIntegrationId: true },
	});
	if (sources.length > 0) {
		throw new InstructionSetError(
			"REPOSITORY_IS_INSTRUCTIONS_SOURCE",
			"Coding Instructions are read from this repository, so it cannot also be one they apply to.",
			{
				repositoryIntegrationIds: [
					...new Set(sources.map((s) => s.repositoryIntegrationId)),
				],
			},
		);
	}
	return unique;
}

async function replaceRepositories(
	tx: Prisma.TransactionClient,
	input: {
		setId: string;
		projectId: string;
		organizationId: string;
		userId: string;
		repositoryIntegrationIds: string[];
	},
): Promise<void> {
	await tx.projectInstructionSetRepository.deleteMany({
		where: {
			setId: input.setId,
			projectId: input.projectId,
			repositoryIntegrationId: { notIn: input.repositoryIntegrationIds },
		},
	});
	if (input.repositoryIntegrationIds.length > 0) {
		await tx.projectInstructionSetRepository.createMany({
			data: input.repositoryIntegrationIds.map(
				(repositoryIntegrationId) => ({
					setId: input.setId,
					repositoryIntegrationId,
					projectId: input.projectId,
					organizationId: input.organizationId,
					userId: input.userId,
				}),
			),
			skipDuplicates: true,
		});
	}
}

function isUniqueViolation(error: unknown): boolean {
	return (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		error.code === "P2002"
	);
}

async function readSet(
	tx: Prisma.TransactionClient,
	projectId: string,
	id: string,
): Promise<InstructionSetView> {
	const row = await tx.projectInstructionSet.findFirst({
		where: { id, projectId, deletedAt: null },
		select: setSelect,
	});
	if (!row) {
		throw new InstructionSetError("SET_NOT_FOUND", "Set not found.");
	}
	return view(row, await otherSetSlugs(tx, projectId));
}

/**
 * A new set with its code repositories. The project's default set is
 * created first when it has none, so the first set a person adds is never
 * mistaken for the existing instructions. The slug comes from the name unless
 * given; `default` is reserved for the default set.
 */
export async function createInstructionSet(input: {
	projectId: string;
	organizationId: string;
	userId: string;
	name: string;
	slug?: string;
	repositoryIntegrationIds: string[];
}): Promise<InstructionSetView> {
	const name = cleanName(input.name);
	const slug = instructionSetSlugFor(input.slug ?? name);
	if (!slug) {
		throw new InstructionSetError(
			"INVALID_SET_NAME",
			"Use at least two letters or digits in the set's name.",
		);
	}
	if (slug === DEFAULT_INSTRUCTION_SET_SLUG) {
		throw new InstructionSetError(
			"SLUG_TAKEN",
			`"${slug}" is kept for the project's default set; choose another name.`,
		);
	}
	try {
		return await db.$transaction(async (tx) => {
			await ensureDefaultInstructionSet(tx, input);
			const repositoryIntegrationIds = await checkCodeRepositories(
				tx,
				input.projectId,
				input.repositoryIntegrationIds,
			);
			const created = await tx.projectInstructionSet.create({
				data: {
					projectId: input.projectId,
					organizationId: input.organizationId,
					userId: input.userId,
					name,
					slug,
				},
				select: { id: true },
			});
			await replaceRepositories(tx, {
				...input,
				setId: created.id,
				repositoryIntegrationIds,
			});
			return readSet(tx, input.projectId, created.id);
		});
	} catch (error) {
		if (isUniqueViolation(error)) {
			throw new InstructionSetError(
				"SLUG_TAKEN",
				`This project already has a set named "${slug}".`,
			);
		}
		throw error;
	}
}

/**
 * Renames a set and/or replaces its code repositories (absent fields stay).
 * The slug never changes. `before` is what the set covered, for the audit.
 */
export async function updateInstructionSet(input: {
	projectId: string;
	organizationId: string;
	userId: string;
	setId: string;
	name?: string;
	repositoryIntegrationIds?: string[];
}): Promise<{ set: InstructionSetView; before: InstructionSetView }> {
	const name = input.name === undefined ? undefined : cleanName(input.name);
	return db.$transaction(async (tx) => {
		const before = await readSet(tx, input.projectId, input.setId);
		if (name !== undefined && name !== before.name) {
			await tx.projectInstructionSet.updateMany({
				where: { id: input.setId, projectId: input.projectId },
				data: { name },
			});
		}
		if (input.repositoryIntegrationIds !== undefined) {
			const repositoryIntegrationIds = await checkCodeRepositories(
				tx,
				input.projectId,
				input.repositoryIntegrationIds,
			);
			await replaceRepositories(tx, {
				...input,
				repositoryIntegrationIds,
			});
			// The list changed without the set row changing: mark it updated.
			await tx.projectInstructionSet.updateMany({
				where: { id: input.setId, projectId: input.projectId },
				data: { updatedAt: new Date() },
			});
		}
		return { set: await readSet(tx, input.projectId, input.setId), before };
	});
}

/**
 * Deletes a set from Fabric (D7): it leaves every list and frees its slug
 * and repositories; its files stay in git and its history rows keep pointing
 * at it. The default set cannot be deleted.
 */
export async function deleteInstructionSet(input: {
	projectId: string;
	setId: string;
}): Promise<InstructionSetView> {
	return db.$transaction(async (tx) => {
		const set = await readSet(tx, input.projectId, input.setId);
		if (set.isDefault) {
			throw new InstructionSetError(
				"DEFAULT_SET_UNDELETABLE",
				"The project's default set cannot be deleted.",
			);
		}
		await tx.projectInstructionSetRepository.deleteMany({
			where: { setId: set.id, projectId: input.projectId },
		});
		await tx.projectInstructionSet.updateMany({
			where: { id: set.id, projectId: input.projectId, deletedAt: null },
			data: { deletedAt: new Date() },
		});
		return set;
	});
}
