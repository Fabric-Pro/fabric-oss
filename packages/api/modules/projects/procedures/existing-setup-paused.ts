/**
 * A project setup paused for a ChatGPT plan reset (Fizzy #2770): what the
 * project page shows while it waits, Cancel, and "Run now on API billing".
 *
 * AUTHORIZATION: reading needs project access; Cancel and Run now need
 * `PROJECT_UPDATE`, as starting the setup does. Run now is further limited
 * to organization admins and owners by `runPausedBulkRunOnApi`. A run id is
 * honoured only for a setup run of this project in its own tenant.
 */

import { ORPCError } from "@orpc/server";
import {
	BULK_RUN_WAITING_STATUS,
	getPausedProjectSetup,
	getProjectSetupRun,
	hasProjectAccess,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	getPausedRunApiAccess,
	runPausedBulkRunOnApi,
} from "../lib/paused-bulk-run";
import {
	cancelPausedSetupRun,
	SETUP_CANCELLED_MESSAGE,
} from "../lib/paused-setup";
import { resolveProjectOrganizationId } from "../lib/project-organization";

const projectInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

async function requireAccess(
	projectId: string,
	userId: string,
	organizationId: string | null,
) {
	if (
		!(await hasProjectAccess(
			projectId,
			userId,
			organizationId ?? undefined,
		))
	) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have access to this project",
		});
	}
}

/** This project's setup run `runId`, never one of another project or tenant. */
async function requireSetupRun(args: {
	runId: string;
	projectId: string;
	organizationId: string | null;
	userId: string;
}) {
	const run = await getProjectSetupRun(args);
	if (!run) {
		throw new ORPCError("NOT_FOUND", { message: "Setup run not found" });
	}
	return run;
}

/**
 * The project's setup paused for a ChatGPT plan reset, if one is: when it
 * resumes, how many documents it still has to write, and whether the viewer
 * may run it now on the organization's AI provider.
 */
export const getPausedSetupProcedure = tenantProtectedProcedure
	.route({
		method: "GET",
		path: "/projects/:projectId/existing-setup/paused",
		tags: ["Projects"],
		summary: "The project setup paused for a ChatGPT plan reset",
	})
	.input(projectInput)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveProjectOrganizationId(
			input.organizationId,
			input.projectId,
		);
		await requireAccess(input.projectId, context.user.id, organizationId);
		const setup = await getPausedProjectSetup({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
		});
		if (!setup) {
			return { setup: null };
		}
		return {
			setup: {
				...setup,
				...(await getPausedRunApiAccess({
					organizationId,
					userId: context.user.id,
				})),
			},
		};
	});

/**
 * Cancel a paused setup: the project's analysis reads FAILED and the
 * documents queued for its resume fail with the reason.
 */
export const cancelPausedSetupProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/existing-setup/paused/cancel",
		tags: ["Projects"],
		summary: "Cancel a project setup paused for a ChatGPT plan reset",
	})
	.input(projectInput.extend({ runId: z.string() }))
	.handler(async ({ input, context }) => {
		const organizationId = await resolveProjectOrganizationId(
			input.organizationId,
			input.projectId,
		);
		await requireAccess(input.projectId, context.user.id, organizationId);
		const run = await requireSetupRun({
			runId: input.runId,
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
		});
		if (run.status !== BULK_RUN_WAITING_STATUS) {
			throw new ORPCError("CONFLICT", {
				message:
					"This setup is no longer waiting for a ChatGPT plan reset.",
			});
		}
		return {
			cancelled: await cancelPausedSetupRun({
				runId: input.runId,
				message: SETUP_CANCELLED_MESSAGE,
			}),
		};
	});

/**
 * "Run now on API billing" for a paused setup: it resumes at once on the
 * organization's own provider, for this run only, audited.
 */
export const runPausedSetupOnApiProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/existing-setup/paused/run-on-api",
		tags: ["Projects"],
		summary:
			"Resume a paused project setup now on the organization's AI provider",
	})
	.input(projectInput.extend({ runId: z.string() }))
	.handler(async ({ input, context }) => {
		const organizationId = await resolveProjectOrganizationId(
			input.organizationId,
			input.projectId,
		);
		await requireAccess(input.projectId, context.user.id, organizationId);
		await requireSetupRun({
			runId: input.runId,
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
		});
		return runPausedBulkRunOnApi({
			context,
			kind: "PROJECT_SETUP",
			runId: input.runId,
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
			impersonatedBy: context.session.impersonatedBy,
		});
	});
