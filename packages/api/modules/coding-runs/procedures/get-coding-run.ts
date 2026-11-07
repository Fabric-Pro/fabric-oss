import {
	type CodingRunActor,
	requireCodingRunProject,
} from "../lib/commands-access";
/**
 * Get Coding Run Procedure
 *
 * AUTHORIZATION: Project visibility plus private/team runtime projection
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
import { publicCodingRuns } from "../lib/public-run";

export const getCodingRunInput = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const getCodingRunProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/coding-runs/{id}",
		tags: ["CodingRuns"],
		summary: "Get a coding run by ID",
	})
	.input(getCodingRunInput)
	.handler(async ({ input, context }) =>
		getCodingRunCommand(
			{
				userId: context.user.id,
				organizationId: resolveOrganizationId(
					input.organizationId,
					context.session,
				),
			},
			input,
		),
	);

export async function getCodingRunCommand(
	actor: CodingRunActor,
	input: z.infer<typeof getCodingRunInput>,
) {
	const user = { id: actor.userId };
	const organizationId = actor.organizationId ?? undefined;

	const run = await getCodingRun(input.id, user.id, organizationId);
	if (!run) {
		throw new ORPCError("NOT_FOUND", {
			message: "Coding run not found",
		});
	}
	await requireCodingRunProject(
		actor,
		run.projectId,
		Permissions.AGENT_READ,
		false,
	);

	const visibleRun = (await publicCodingRuns([run], user.id))[0];
	if (!visibleRun) {
		throw new ORPCError("NOT_FOUND");
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
					...visibleRun,
					externalUrl: `${legacyBase.replace(/\/$/, "")}/session/${encodeURIComponent(run.providerSessionId)}`,
				};
			}
		} catch {
			/* Invalid configuration does not create a link. */
		}
	}
	return visibleRun;
}
