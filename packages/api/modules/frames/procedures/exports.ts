import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	cancelFrameExport,
	downloadFrameExport,
	FrameExportError,
	getFrameExport,
	startFrameExport,
	startFrameExportSchema,
} from "../lib/frame-export-service";

function organization(
	...args: Parameters<typeof resolveOrganizationId>
): string {
	const id = resolveOrganizationId(...args);
	if (!id) {
		throw new ORPCError("FORBIDDEN", {
			message: "An organization is required.",
		});
	}
	return id;
}
const base = tenantProtectedProcedure.use(
	requirePermission(Permissions.WORKSPACE_READ),
);
const common = {
	id: z.string().min(1).max(200),
	organizationId: z.string().nullable().optional(),
};
const jobSchema = z.strictObject({
	...common,
	exportId: z.string().min(1).max(200),
});
async function safe<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof FrameExportError) {
			throw new ORPCError(
				error.status === 400
					? "BAD_REQUEST"
					: error.status === 404
						? "NOT_FOUND"
						: error.status === 409
							? "CONFLICT"
							: "SERVICE_UNAVAILABLE",
				{ message: error.message },
			);
		}
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message:
				"Export could not be confirmed. Retry with the same export identity.",
		});
	}
}
export const startFrameExportProcedure = base
	.route({
		method: "POST",
		path: "/frames/{id}/exports",
		tags: ["Frames"],
		summary: "Export a reviewed page to PDF",
	})
	.input(startFrameExportSchema.omit({ frameId: true }).extend(common))
	.handler(({ input, context }) =>
		safe(() =>
			startFrameExport(
				{
					userId: context.user.id,
					userEmail: context.user.email,
					organizationId: organization(
						input.organizationId,
						context.session,
					),
				},
				{
					frameId: input.id,
					expectedUpdatedAt: input.expectedUpdatedAt,
					requestId: input.requestId,
					orientation: input.orientation,
				},
			),
		),
	);
export const getFrameExportProcedure = base
	.route({
		method: "GET",
		path: "/frames/{id}/exports/{exportId}",
		tags: ["Frames"],
		summary: "Inspect a page export",
	})
	.input(jobSchema)
	.handler(({ input, context }) =>
		safe(() =>
			getFrameExport(
				{
					userId: context.user.id,
					userEmail: context.user.email,
					organizationId: organization(
						input.organizationId,
						context.session,
					),
				},
				{ frameId: input.id, exportId: input.exportId },
			),
		),
	);
export const cancelFrameExportProcedure = base
	.route({
		method: "POST",
		path: "/frames/{id}/exports/{exportId}/cancel",
		tags: ["Frames"],
		summary: "Cancel a page export",
	})
	.input(jobSchema)
	.handler(({ input, context }) =>
		safe(() =>
			cancelFrameExport(
				{
					userId: context.user.id,
					userEmail: context.user.email,
					organizationId: organization(
						input.organizationId,
						context.session,
					),
				},
				{ frameId: input.id, exportId: input.exportId },
			),
		),
	);
export const downloadFrameExportProcedure = base
	.route({
		method: "POST",
		path: "/frames/{id}/exports/{exportId}/download",
		tags: ["Frames"],
		summary: "Download a page export with current access",
	})
	.input(jobSchema)
	.handler(({ input, context }) =>
		safe(() =>
			downloadFrameExport(
				{
					userId: context.user.id,
					userEmail: context.user.email,
					organizationId: organization(
						input.organizationId,
						context.session,
					),
				},
				{ frameId: input.id, exportId: input.exportId },
			),
		),
	);
