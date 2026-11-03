import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import {
	isPluginName,
	projectPluginName,
	slugForPlugin,
} from "@repo/instructions";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";

/**
 * The Coding Instructions plugin's name in coding tools (`/<name>:<skill>`,
 * specs/2026-10-21-ai-artifacts-hub). Defaults to the project's name as a
 * slug; a project can set its own. Coding tools pick it up on their next
 * set-up, and an existing install with `fabric instructions init --rename`.
 *
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * INSTRUCTION_READ to read, INSTRUCTION_UPDATE to change.
 */
async function loadProject(projectId: string) {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { id: true, name: true, instructionPluginName: true },
	});
	if (!project) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}
	return project;
}

function view(project: {
	id: string;
	name: string;
	instructionPluginName: string | null;
}) {
	return {
		name: projectPluginName(project),
		custom: project.instructionPluginName !== null,
		defaultName: projectPluginName({
			...project,
			instructionPluginName: null,
		}),
	};
}

export const getPluginNameProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/plugin-name",
		tags: ["Projects", "Instructions"],
		summary: "The Coding Instructions plugin's name in coding tools",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => view(await loadProject(input.projectId)));

export const setPluginNameProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_UPDATE))
	.route({
		method: "PUT",
		path: "/projects/:projectId/instructions/plugin-name",
		tags: ["Projects", "Instructions"],
		summary:
			"Set the Coding Instructions plugin's name (null: the default)",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			/** Typed by a person: made a valid name; null or empty restores the default. */
			name: z.string().max(100).nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const typed = input.name?.trim() ?? "";
		const name = typed === "" ? null : slugForPlugin(typed);
		if (typed !== "" && (name === null || !isPluginName(name))) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Use 2–40 lowercase letters, digits and single dashes, for example slotik or checkout-api.",
				data: { code: "INVALID_PLUGIN_NAME" },
			});
		}
		const project = await db.project.update({
			where: { id: input.projectId },
			data: { instructionPluginName: name },
			select: { id: true, name: true, instructionPluginName: true },
		});
		recordAuditFromRequest(context, {
			action: "project.instructions.settings_updated",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: { type: "project", id: input.projectId, name: null },
			metadata: { pluginNameCustom: name !== null },
		});
		return view(project);
	});
