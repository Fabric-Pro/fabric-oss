/**
 * Per-project QA policy (Settings ▸ Testing) and the deployment targets it
 * references (Settings ▸ Environments).
 *
 * Reads are lazy: a project that has never opened the page has no row, and
 * {@link getProjectQaSettings} answers with {@link QA_SETTINGS_DEFAULTS} rather
 * than creating one, so merely *viewing* settings never writes. The row appears
 * on first save.
 */

import {
	db,
	type ProjectEnvironmentType,
	type QaEvidencePolicy,
	type QaStrategyDepth,
} from "../../client";
import { DEFAULT_PIPELINE_SYNC_INTERVAL_MINUTES } from "./pipeline-sync-schedule";

/**
 * The adversarial personas that may append test cases during planning. Keys are
 * stored (not labels), so copy can change without a migration and an unknown key
 * from an older row is simply ignored by the UI.
 */
export const QA_SCEPTIC_ROLES = [
	"security",
	"ux",
	"performance",
	"accessibility",
	"edgeCase",
] as const;
export type QaScepticRole = (typeof QA_SCEPTIC_ROLES)[number];

/** What a project gets before anyone has saved the page. */
export const QA_SETTINGS_DEFAULTS = {
	strategyDepth: "AVERAGE" as QaStrategyDepth,
	// Empty means "follow the depth tier", which is what every project did
	// before this control existed. Callers resolve it through
	// `resolveRequiredTestTypes`; nothing should read this list raw.
	requiredTestTypes: [] as string[],
	confidenceThreshold: 80,
	indexCoverageEnabled: true,
	coverageTarget: 80,
	requiredQaSignOffs: 0,
	resolutions: ["1920x1080", "1366x768"],
	browsers: ["chromium"],
	rulesMarkdown: null as string | null,
	implementationNotes: null as string | null,
	evidencePolicy: "SCREENSHOT_REQUIRED" as QaEvidencePolicy,
	evidenceRetentionDays: 90,
	scepticRolesEnabled: true,
	scepticRoles: [...QA_SCEPTIC_ROLES] as string[],
	defaultEnvironmentId: null as string | null,
	// Automatic pipeline-result sync. These defaults reproduce the
	// shipped behaviour exactly, so a project that never opens the page keeps
	// syncing every 15 minutes as it always did.
	pipelineSyncEnabled: true,
	pipelineSyncIntervalMinutes:
		DEFAULT_PIPELINE_SYNC_INTERVAL_MINUTES as number,
	// PR review lenses. Both ON for the same reason as the
	// sync defaults above: a project that never opens the page behaves exactly as
	// it did before these existed.
	prReviewQaLensEnabled: true,
	prReviewArchitectureLensEnabled: true,
	// Automatic review, OFF by default. Unlike the two above, turning this on
	// makes Fabric write into the team's pull requests, so it is the one setting
	// here that an unconfigured project must not inherit.
	prReviewAutoReviewEnabled: false,
	architectureRules: null as string | null,
};

export type ProjectQaSettingsView = typeof QA_SETTINGS_DEFAULTS & {
	/** False until the project has saved once — the UI can say "using defaults". */
	configured: boolean;
};

const qaSettingsSelect = {
	strategyDepth: true,
	requiredTestTypes: true,
	confidenceThreshold: true,
	indexCoverageEnabled: true,
	coverageTarget: true,
	requiredQaSignOffs: true,
	resolutions: true,
	browsers: true,
	rulesMarkdown: true,
	implementationNotes: true,
	evidencePolicy: true,
	evidenceRetentionDays: true,
	scepticRolesEnabled: true,
	scepticRoles: true,
	defaultEnvironmentId: true,
	pipelineSyncEnabled: true,
	pipelineSyncIntervalMinutes: true,
	prReviewQaLensEnabled: true,
	prReviewArchitectureLensEnabled: true,
	prReviewAutoReviewEnabled: true,
	architectureRules: true,
} as const;

/**
 * The project's QA policy, or the defaults when it has never been saved.
 * Scoped by projectId — the project is the tenant boundary and the caller's
 * project access is enforced upstream.
 */
export async function getProjectQaSettings(
	projectId: string,
): Promise<ProjectQaSettingsView> {
	const row = await db.projectQaSettings.findUnique({
		where: { projectId },
		select: qaSettingsSelect,
	});
	if (!row) {
		return { ...QA_SETTINGS_DEFAULTS, configured: false };
	}
	return { ...row, configured: true };
}

/**
 * The tenant columns a child row must carry, read from the PARENT PROJECT —
 * never from caller input.
 *
 * `requireProjectPermission` authorizes the project but does not look at the
 * organization, so trusting a caller-supplied `organizationId` would let someone
 * pair a project they can legitimately reach with an organization they cannot
 * (SOC 2 CC6.1/CC6.3 — the shape the input-org ratchet exists to stop). The
 * project is the tenant boundary, so its own columns are the authoritative
 * answer.
 */
export async function projectTenant(
	projectId: string,
): Promise<{ organizationId: string | null; userId: string | null }> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true, userId: true },
	});
	return {
		organizationId: project?.organizationId ?? null,
		userId: project?.userId ?? null,
	};
}

export type UpsertProjectQaSettingsInput = {
	projectId: string;
} & Partial<typeof QA_SETTINGS_DEFAULTS>;

/**
 * Create or update the project's QA policy. Only the fields the caller passed
 * are written, so a partial save (one section of the page) can't blank the rest.
 */
export async function upsertProjectQaSettings(
	input: UpsertProjectQaSettingsInput,
): Promise<ProjectQaSettingsView> {
	const { projectId, ...fields } = input;
	// Drop `undefined` so an omitted field keeps its stored value instead of
	// being written as null.
	const data = Object.fromEntries(
		Object.entries(fields).filter(([, v]) => v !== undefined),
	);

	const row = await db.projectQaSettings.upsert({
		where: { projectId },
		create: { projectId, ...(await projectTenant(projectId)), ...data },
		update: data,
		select: qaSettingsSelect,
	});
	return { ...row, configured: true };
}

const environmentSelect = {
	id: true,
	type: true,
	name: true,
	baseUrl: true,
	signInUrl: true,
	createdAt: true,
} as const;

export type ProjectEnvironmentView = {
	id: string;
	type: ProjectEnvironmentType;
	name: string;
	baseUrl: string;
	signInUrl: string | null;
	createdAt: Date;
};

/** The project's deployment targets, oldest first (stable display order). */
export async function listProjectEnvironments(
	projectId: string,
): Promise<ProjectEnvironmentView[]> {
	return db.projectEnvironment.findMany({
		where: { projectId },
		orderBy: { createdAt: "asc" },
		select: environmentSelect,
	});
}

export async function getProjectEnvironment(input: {
	projectId: string;
	environmentId: string;
}): Promise<ProjectEnvironmentView | null> {
	return db.projectEnvironment.findFirst({
		where: {
			id: input.environmentId,
			projectId: input.projectId,
		},
		select: environmentSelect,
	});
}

export async function createProjectEnvironment(input: {
	projectId: string;
	type: ProjectEnvironmentType;
	name: string;
	baseUrl: string;
	signInUrl?: string;
}): Promise<ProjectEnvironmentView> {
	const { signInUrl, ...rest } = input;
	return db.projectEnvironment.create({
		data: {
			...rest,
			// Empty means "the form is at the base URL" — stored as NULL so the
			// runner has one absent-value to check rather than two.
			signInUrl: signInUrl?.trim() || null,
			...(await projectTenant(input.projectId)),
		},
		select: environmentSelect,
	});
}

/**
 * Update one target. Scoped by projectId as well as id so a caller can't edit
 * another project's environment by guessing an id.
 */
export async function updateProjectEnvironment(input: {
	projectId: string;
	environmentId: string;
	type?: ProjectEnvironmentType;
	name?: string;
	baseUrl?: string;
	signInUrl?: string;
}): Promise<ProjectEnvironmentView | null> {
	const { projectId, environmentId, signInUrl, ...fields } = input;
	const data: Record<string, unknown> = Object.fromEntries(
		Object.entries(fields).filter(([, v]) => v !== undefined),
	);
	// An empty string is how the form CLEARS the sign-in URL, so it must survive
	// the undefined filter above and reach the row as NULL. Dropping it there
	// would make clearing silently impossible.
	if (signInUrl !== undefined) {
		data.signInUrl = signInUrl.trim() || null;
	}
	const result = await db.projectEnvironment.updateMany({
		where: { id: environmentId, projectId },
		data,
	});
	if (result.count === 0) {
		return null;
	}
	return db.projectEnvironment.findUnique({
		where: { id: environmentId },
		select: environmentSelect,
	});
}

/**
 * Delete a target. Any QA policy pointing at it is cleared in the same
 * transaction — `defaultEnvironmentId` is deliberately not a foreign key, so
 * nothing else would drop the dangling reference.
 */
export async function deleteProjectEnvironment(input: {
	projectId: string;
	environmentId: string;
}): Promise<ProjectEnvironmentView | null> {
	const { projectId, environmentId } = input;
	return db.$transaction(async (tx) => {
		const environment = await tx.projectEnvironment.findFirst({
			where: {
				id: environmentId,
				projectId,
			},
			select: environmentSelect,
		});
		if (!environment) {
			return null;
		}
		await tx.projectEnvironment.delete({
			where: { id: environmentId },
		});
		await tx.projectQaSettings.updateMany({
			where: { projectId, defaultEnvironmentId: environmentId },
			data: { defaultEnvironmentId: null },
		});
		return environment;
	});
}
