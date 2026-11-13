import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadWebResearchAvailability } from "../../lib/web-research-availability";

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(DOCUMENT_READ).
 *
 * Whether documents in this project can research the web, and which half
 * (search, read) the organization is missing. The create and regenerate
 * surfaces use it to explain a disabled "Allow web research" option.
 *
 * DOCUMENT_READ is the floor shared by everyone who can create (CREATE) or
 * regenerate (UPDATE) a document, and the answer is configuration presence
 * only: no provider name, key or endpoint leaves the server.
 *
 * The organization comes from the project row, never from the caller: the
 * input has no `organizationId`, and the row is loaded by id alone because the
 * middleware has already authorized this project.
 */
export const getWebResearchAvailabilityProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/documents/web-research-availability",
		tags: ["Projects", "Documents"],
		summary: "Check whether document generation can research the web",
		description:
			"Whether the project's organization has an enabled search provider that can search and one that can read pages, and which is missing.",
	})
	.input(z.object({ projectId: z.string() }))
	.handler(async ({ input }) => {
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		// A project without an organization answers unavailable rather than
		// failing: the option stays visible and explains itself.
		return loadWebResearchAvailability(project.organizationId);
	});
