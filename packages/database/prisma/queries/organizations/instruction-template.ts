/**
 * The organization's template for coding instructions: the one project whose
 * published files the organization's other projects can start from.
 *
 * Read and written here, together with the candidate check, so that "a
 * template is a live upload-mode project of the same organization" is decided
 * in one place for the picker, the setting and every project that copies from
 * it.
 */

import { db } from "../../client";
import { migrationOfSettings } from "../instruction-migration-pointer";

export type OrganizationInstructionTemplate = {
	projectId: string;
	projectName: string;
	/** The template project's published snapshot, or null when nothing is published. */
	publishedSnapshotId: string | null;
};

/**
 * The organization's template project, or null when none is set or the
 * project it names is no longer a live project of this organization.
 *
 * The organization filter is checked here rather than trusted from the
 * write: the setting stores an id, and an id is only a template while the row
 * it names still belongs to the organization that chose it.
 */
export async function getOrganizationInstructionTemplate(
	organizationId: string,
): Promise<OrganizationInstructionTemplate | null> {
	const org = await db.organization.findUnique({
		where: { id: organizationId },
		select: {
			instructionTemplateProject: {
				select: {
					id: true,
					name: true,
					organizationId: true,
					deletedAt: true,
					publishedInstructionSnapshotId: true,
				},
			},
		},
	});
	const project = org?.instructionTemplateProject;
	if (
		!project ||
		project.organizationId !== organizationId ||
		project.deletedAt !== null
	) {
		return null;
	}
	return {
		projectId: project.id,
		projectName: project.name,
		publishedSnapshotId: project.publishedInstructionSnapshotId,
	};
}

/**
 * Whether a project's `instructionSettings` lets it be the template: its
 * files are uploaded to Fabric, and no move into a repository is open. A
 * repository-backed project's files belong to its repository, and a copy
 * would not follow its later commits.
 */
export function isInstructionTemplateEligible(settings: unknown): boolean {
	const fromRepository =
		typeof settings === "object" &&
		settings !== null &&
		"sourceOfTruth" in settings &&
		settings.sourceOfTruth === "REPOSITORY";
	return !fromRepository && migrationOfSettings(settings) === null;
}

/**
 * A live project of this organization, and whether it may be named as the
 * template (`isInstructionTemplateEligible`).
 */
export async function findInstructionTemplateCandidate(
	projectId: string,
	organizationId: string,
): Promise<{ id: string; name: string; eligible: boolean } | null> {
	const project = await db.project.findFirst({
		where: { id: projectId, organizationId, deletedAt: null },
		select: { id: true, name: true, instructionSettings: true },
	});
	return project
		? {
				id: project.id,
				name: project.name,
				eligible: isInstructionTemplateEligible(
					project.instructionSettings,
				),
			}
		: null;
}

/**
 * Every live project of this organization that may be named as its template,
 * with whether it has a published version to copy yet. Projects with a
 * published version come first, since only those have files to copy today;
 * names are compared ignoring case, and numbers in them by value.
 */
export async function listInstructionTemplateCandidates(
	organizationId: string,
): Promise<Array<{ id: string; name: string; published: boolean }>> {
	const projects = await db.project.findMany({
		where: { organizationId, deletedAt: null },
		select: {
			id: true,
			name: true,
			instructionSettings: true,
			publishedInstructionSnapshotId: true,
		},
	});
	return projects
		.filter((project) =>
			isInstructionTemplateEligible(project.instructionSettings),
		)
		.map((project) => ({
			id: project.id,
			name: project.name,
			published: project.publishedInstructionSnapshotId !== null,
		}))
		.sort(
			(a, b) =>
				Number(b.published) - Number(a.published) ||
				a.name.localeCompare(b.name, undefined, {
					sensitivity: "base",
					numeric: true,
				}),
		);
}

/** Set or clear the template. The caller has already checked the candidate. */
export async function updateOrganizationInstructionTemplate(input: {
	organizationId: string;
	projectId: string | null;
}): Promise<{ projectId: string | null }> {
	const updated = await db.organization.update({
		where: { id: input.organizationId },
		data: { instructionTemplateProjectId: input.projectId },
		select: { instructionTemplateProjectId: true },
	});
	return { projectId: updated.instructionTemplateProjectId };
}
