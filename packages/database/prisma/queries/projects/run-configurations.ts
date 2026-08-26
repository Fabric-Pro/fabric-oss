/**
 * Saved run configurations (mocks C8) — a named way to start the same shaped
 * Fabric run again.
 *
 * A configuration says HOW a run executes (which environment, which browser,
 * which resolution), never WHICH cases. A saved case list would go stale the
 * moment somebody added a case, and would quietly stop covering new work while
 * still looking like a regression suite.
 *
 * Every field is nullable and means "fall back to the project's QA policy", so a
 * configuration stays meaningful after the policy changes rather than freezing a
 * copy of it.
 */

import { db, type QaRunMode } from "../../client";

/** The name every project's seeded configuration carries. */
export const SYSTEM_RUN_CONFIGURATION_NAME = "Project defaults";

export interface RunConfigurationView {
	id: string;
	name: string;
	isSystem: boolean;
	runMode: QaRunMode;
	environmentId: string | null;
	browser: string | null;
	resolution: string | null;
}

const configurationSelect = {
	id: true,
	name: true,
	isSystem: true,
	runMode: true,
	environmentId: true,
	browser: true,
	resolution: true,
} as const;

/**
 * The project's configurations, the seeded one first and the rest by name.
 *
 * Ordered rather than left to insertion order because this backs a picker, and a
 * picker whose first entry moves around is one people mis-click.
 */
export async function listRunConfigurations(
	projectId: string,
): Promise<RunConfigurationView[]> {
	return db.testRunConfiguration.findMany({
		where: { projectId },
		orderBy: [{ isSystem: "desc" }, { name: "asc" }],
		select: configurationSelect,
	});
}

/**
 * The tenant columns a child row must carry, read from the PARENT PROJECT.
 *
 * Never from caller input: `requireProjectPermission` authorizes the project but
 * does not look at the organization, so trusting a caller-supplied one would let
 * someone pair a project they can reach with an organization they cannot.
 */
async function projectTenant(projectId: string) {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true, userId: true },
	});
	return {
		organizationId: project?.organizationId ?? null,
		userId: project?.userId ?? null,
	};
}

/**
 * Ensure the project has its seeded configuration.
 *
 * Called on read rather than at project creation, so projects that predate this
 * feature get one too — and idempotent, so concurrent readers cannot mint two.
 * Without it the picker would be empty on every existing project, which reads as
 * a broken feature rather than an unconfigured one.
 */
export async function ensureSystemRunConfiguration(
	projectId: string,
): Promise<RunConfigurationView> {
	const existing = await db.testRunConfiguration.findUnique({
		where: {
			projectId_name: {
				projectId,
				name: SYSTEM_RUN_CONFIGURATION_NAME,
			},
		},
		select: configurationSelect,
	});
	if (existing) {
		return existing;
	}
	return db.testRunConfiguration.create({
		data: {
			projectId,
			name: SYSTEM_RUN_CONFIGURATION_NAME,
			isSystem: true,
			// All null: the seeded configuration IS "whatever the QA policy says",
			// so it keeps following the policy instead of pinning today's values.
			...(await projectTenant(projectId)),
		},
		select: configurationSelect,
	});
}

export async function createRunConfiguration(input: {
	projectId: string;
	name: string;
	environmentId?: string | null;
	browser?: string | null;
	resolution?: string | null;
	runMode?: QaRunMode;
}): Promise<RunConfigurationView> {
	const { projectId, ...fields } = input;
	return db.testRunConfiguration.create({
		data: {
			projectId,
			...fields,
			...(await projectTenant(projectId)),
		},
		select: configurationSelect,
	});
}

/**
 * Update one configuration. Scoped by projectId as well as id, so an id from
 * another project matches nothing rather than being edited across the boundary.
 *
 * The seeded row's NAME is fixed — it is referred to by that name in copy and in
 * the picker's first slot — but its targets are editable, because "the project
 * defaults, except always Firefox" is a reasonable thing to want.
 */
export async function updateRunConfiguration(input: {
	projectId: string;
	configurationId: string;
	name?: string;
	environmentId?: string | null;
	browser?: string | null;
	resolution?: string | null;
	runMode?: QaRunMode;
}): Promise<RunConfigurationView | null> {
	const { projectId, configurationId, ...fields } = input;
	const existing = await db.testRunConfiguration.findFirst({
		where: { id: configurationId, projectId },
		select: { isSystem: true },
	});
	if (!existing) {
		return null;
	}
	const data = Object.fromEntries(
		Object.entries(fields).filter(([key, value]) => {
			if (value === undefined) {
				return false;
			}
			return !(existing.isSystem && key === "name");
		}),
	);
	await db.testRunConfiguration.update({
		where: { id: configurationId },
		data,
	});
	return db.testRunConfiguration.findUnique({
		where: { id: configurationId },
		select: configurationSelect,
	});
}

/**
 * Delete one configuration. The seeded row is refused: it is the guarantee that
 * the picker is never empty, and a project with no configuration at all cannot
 * start a run from this surface.
 */
export async function deleteRunConfiguration(input: {
	projectId: string;
	configurationId: string;
}): Promise<{ deleted: boolean; reason?: "SYSTEM" | "NOT_FOUND" }> {
	const existing = await db.testRunConfiguration.findFirst({
		where: { id: input.configurationId, projectId: input.projectId },
		select: { isSystem: true },
	});
	if (!existing) {
		return { deleted: false, reason: "NOT_FOUND" };
	}
	if (existing.isSystem) {
		return { deleted: false, reason: "SYSTEM" };
	}

	await db.testRunConfiguration.delete({
		where: { id: input.configurationId },
	});
	return { deleted: true };
}
