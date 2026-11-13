import { ORPCError } from "@orpc/client";
import {
	createInstructionSet,
	deleteInstructionSet,
	InstructionSetError,
	type InstructionSetErrorCode,
	type InstructionSetView,
	listInstructionSets,
	updateInstructionSet,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { listProjectCodeRepositories } from "../../lib/code-repositories";
import { requireHostingOrganizationId } from "./hosting-organization";

/**
 * Coding Instructions sets (spec 2026-11-11 §4.1, §4.5): a project's named
 * groups of instructions, each applying to the code repositories chosen for
 * it. List, create, rename / reassign, delete. The same query code serves
 * the CLI, MCP and the Fabric Agent.
 *
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * INSTRUCTION_READ to list, INSTRUCTION_UPDATE to change (D4: project-level).
 * Every query is narrowed by the authorized projectId, so a set or repository
 * id of another project answers NOT_FOUND.
 */

const STATUS: Record<
	InstructionSetErrorCode,
	"NOT_FOUND" | "BAD_REQUEST" | "CONFLICT"
> = {
	SET_NOT_FOUND: "NOT_FOUND",
	INVALID_SET_NAME: "BAD_REQUEST",
	SLUG_TAKEN: "CONFLICT",
	DEFAULT_SET_UNDELETABLE: "BAD_REQUEST",
	REPOSITORY_NOT_FOUND: "BAD_REQUEST",
	REPOSITORY_IS_INSTRUCTIONS_SOURCE: "BAD_REQUEST",
};

async function mapped<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof InstructionSetError) {
			throw new ORPCError(STATUS[error.code], {
				message: error.message,
				data: { code: error.code, ...error.details },
			});
		}
		throw error;
	}
}

function view(set: InstructionSetView) {
	return {
		id: set.id,
		name: set.name,
		slug: set.slug,
		isDefault: set.isDefault,
		repositoryIntegrationIds: set.repositoryIntegrationIds,
		folder: set.folder,
		excludedFolders: set.excludedFolders,
		createdAt: set.createdAt.toISOString(),
		updatedAt: set.updatedAt.toISOString(),
	};
}

const projectInput = {
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
};
const repositoryIds = z.array(z.string().min(1)).max(200);

export const listInstructionSetsProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/sets",
		tags: ["Projects", "Instructions"],
		summary: "List the project's Coding Instructions sets",
	})
	.input(z.object(projectInput))
	.handler(async ({ input }) => {
		const [sets, repositories] = await Promise.all([
			listInstructionSets(input.projectId),
			listProjectCodeRepositories(input.projectId),
		]);
		return {
			sets: sets.map(view),
			// What a set may cover, for the Portal's chooser: every connected
			// repository except one Coding Instructions are read from.
			codeRepositories: repositories.map((r) => ({
				id: r.id,
				name: r.name,
				provider: r.provider,
				roleTag: r.roleTag,
			})),
		};
	});

export const createInstructionSetProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/sets",
		tags: ["Projects", "Instructions"],
		summary:
			"Create a Coding Instructions set for chosen code repositories",
	})
	.input(
		z.object({
			...projectInput,
			name: z.string().max(200),
			/** Derived from the name when absent; never changes afterwards. */
			slug: z.string().max(80).optional(),
			repositoryIntegrationIds: repositoryIds.default([]),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const set = await mapped(() =>
			createInstructionSet({
				projectId: input.projectId,
				organizationId,
				userId: context.user.id,
				name: input.name,
				slug: input.slug,
				repositoryIntegrationIds: input.repositoryIntegrationIds,
			}),
		);
		recordAuditFromRequest(context, {
			action: "project.instructions.set_created",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_set",
				id: set.id,
				name: set.name,
			},
			metadata: {
				slug: set.slug,
				repositoryCount: set.repositoryIntegrationIds.length,
			},
		});
		return view(set);
	});

export const updateInstructionSetProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/instructions/sets/:setId",
		tags: ["Projects", "Instructions"],
		summary:
			"Rename a Coding Instructions set or change its code repositories",
	})
	.input(
		z.object({
			...projectInput,
			setId: z.string(),
			name: z.string().max(200).optional(),
			/** The full new list; absent keeps the current one. */
			repositoryIntegrationIds: repositoryIds.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const { set, before } = await mapped(() =>
			updateInstructionSet({
				projectId: input.projectId,
				organizationId,
				userId: context.user.id,
				setId: input.setId,
				name: input.name,
				repositoryIntegrationIds: input.repositoryIntegrationIds,
			}),
		);
		recordAuditFromRequest(context, {
			action: "project.instructions.set_updated",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_set",
				id: set.id,
				name: set.name,
			},
			metadata: {
				renamed: before.name !== set.name,
				repositoryCount: set.repositoryIntegrationIds.length,
				previousRepositoryCount: before.repositoryIntegrationIds.length,
			},
		});
		return view(set);
	});

export const deleteInstructionSetProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_UPDATE))
	.route({
		method: "DELETE",
		path: "/projects/:projectId/instructions/sets/:setId",
		tags: ["Projects", "Instructions"],
		summary:
			"Delete a Coding Instructions set from Fabric (its files stay in git)",
	})
	.input(z.object({ ...projectInput, setId: z.string() }))
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const set = await mapped(() =>
			deleteInstructionSet({
				projectId: input.projectId,
				setId: input.setId,
			}),
		);
		recordAuditFromRequest(context, {
			action: "project.instructions.set_deleted",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_set",
				id: set.id,
				name: set.name,
			},
			metadata: { slug: set.slug },
		});
		return { id: set.id, deleted: true as const };
	});
