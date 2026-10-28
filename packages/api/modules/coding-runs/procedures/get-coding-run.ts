/**
 * Get Coding Run Procedure
 *
 * AUTHORIZATION: Uses canEditProject() via coding run's projectId
 */

import { ORPCError } from "@orpc/client";
import { getCodingRun } from "@repo/database";
import { isFabricAgentsBridgeEnabled } from "@repo/temporal/coding-execution-rollout";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const getCodingRunProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/coding-runs/{id}",
		tags: ["CodingRuns"],
		summary: "Get a coding run by ID",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const run = await getCodingRun(input.id, user.id, organizationId);
		if (!run) {
			throw new ORPCError("NOT_FOUND", {
				message: "Coding run not found",
			});
		}

		// Only the disabled legacy profile may supply the old explicitly configured
		// HTTP route. Native headless sessions never gain guessed executor links.
		const metadata = run.providerMetadata;
		const legacy =
			metadata === null ||
			(typeof metadata === "object" &&
				!Array.isArray(metadata) &&
				metadata?.executionRuntime === "legacy-background-agents");
		const legacyBase = process.env.NEXT_PUBLIC_BACKGROUND_AGENTS_URL;
		if (
			!run.externalUrl &&
			run.provider === "BACKGROUND_AGENTS" &&
			run.providerSessionId &&
			!isFabricAgentsBridgeEnabled() &&
			legacy &&
			legacyBase
		) {
			try {
				const base = new URL(legacyBase);
				if (base.protocol === "https:" || base.protocol === "http:") {
					return {
						...run,
						externalUrl: `${legacyBase.replace(/\/$/, "")}/session/${encodeURIComponent(run.providerSessionId)}`,
					};
				}
			} catch {
				/* Invalid configuration does not create a link. */
			}
		}
		return run;
	});
