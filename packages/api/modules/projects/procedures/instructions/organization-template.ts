/**
 * The organization template for coding instructions as one project sees it:
 * whether its organization names a template, and that template's published
 * version.
 *
 * The organization's designation is the whole authority. A project that
 * starts from the template does not need access to the template project, so
 * every read here is scoped by the organization the TARGET project lives in,
 * never by anything the caller sends, and nothing here returns the template
 * project's name or its file contents.
 */
import { ORPCError } from "@orpc/client";
import {
	getInstructionSnapshot,
	getOrganizationInstructionTemplate,
	listInstructionFiles,
} from "@repo/database";
import { snapshotKey } from "@repo/instructions";

type TemplateSnapshot = NonNullable<
	Awaited<ReturnType<typeof getInstructionSnapshot>>
>;

type OrganizationTemplateState =
	| { state: "not_set" }
	/** The project asking is the template itself. */
	| { state: "is_template" }
	/** A template is named, and it has no published version to copy. */
	| { state: "nothing_published" }
	| {
			state: "available";
			templateProjectId: string;
			snapshot: TemplateSnapshot;
	  };

export async function readOrganizationTemplate(input: {
	organizationId: string;
	projectId: string;
}): Promise<OrganizationTemplateState> {
	const template = await getOrganizationInstructionTemplate(
		input.organizationId,
	);
	if (!template) {
		return { state: "not_set" };
	}
	if (template.projectId === input.projectId) {
		return { state: "is_template" };
	}
	// The pointer read is the template project's own column; the
	// tenant-scoped read is what proves the snapshot belongs to the template
	// project in THIS organization.
	const snapshot = template.publishedSnapshotId
		? await getInstructionSnapshot(
				template.publishedSnapshotId,
				template.projectId,
				input.organizationId,
			)
		: null;
	if (
		!snapshot ||
		snapshot.status !== "READY" ||
		snapshot.contentKind !== "FULL_SNAPSHOT"
	) {
		return { state: "nothing_published" };
	}
	return {
		state: "available",
		templateProjectId: template.projectId,
		snapshot,
	};
}

/**
 * The template version's file rows, each one checked to sit at the promoted
 * key of its own snapshot before anything is copied from it.
 *
 * The same rule an inherited row is held to (`isAcceptableInheritedSource`):
 * a READY snapshot's objects were promoted into its own immutable prefix, and
 * the key is rebuilt from ids rather than trusted from the column. A row that
 * points anywhere else names storage no promotion wrote, so the copy is
 * refused rather than reading bytes from another project's prefix.
 */
export async function listTemplateFiles(input: {
	organizationId: string;
	templateProjectId: string;
	snapshotId: string;
}) {
	const rows = await listInstructionFiles(
		input.snapshotId,
		input.organizationId,
	);
	for (const row of rows) {
		if (
			row.storageKey !==
			snapshotKey(input.templateProjectId, input.snapshotId, row.id)
		) {
			throw new ORPCError("CONFLICT", {
				message:
					"The organization template's stored files are not in a state that can be copied. Ask an organization admin to publish the template again.",
				data: { reason: "TEMPLATE_UNAVAILABLE" },
			});
		}
	}
	return rows;
}
