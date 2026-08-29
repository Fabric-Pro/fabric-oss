/**
 * `newsletter.settings.regenerateEmbedToken` — owner-only rotation of a
 * project's embeddable-widget embed token.
 *
 * Rotating mints a brand-new token AND bumps `publicEmbedTokenVersion`, durably
 * revoking any previously-issued embed (and any subscriber stamped at an older
 * version's confirm gate). This is a public-exposure change, so the rotate + its
 * audit row commit together in ONE transaction via `recordAuditTx` (awaited
 * in-tx, errors propagate): the token must not rotate without its trail.
 *
 * Authorization mirrors `settings-update.ts`: `tenantProtectedProcedure` +
 * `requireProjectPermission(PROJECT_SETTINGS_EDIT)` + a XOR project lookup so a
 * cross-tenant project id returns NOT_FOUND.
 */

import { ORPCError } from "@orpc/server";
import { db, recordAuditTx, regenerateEmbedToken } from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { buildWidgetAuditInput } from "../audit";

export const regenerateEmbedTokenProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// `requireProjectPermission` above has already authorized this caller for
		// THIS project — as owner, active ProjectMember, or via an org role. Load
		// the project by id and take the tenant from the loaded row;
		// `input.organizationId` is a guard, never a scoping key.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		assertInputOrgMatchesProject(input.organizationId, project);

		return db.$transaction(async (tx) => {
			const result = await regenerateEmbedToken(input.projectId, tx);
			await recordAuditTx(
				tx,
				buildWidgetAuditInput(context, project, "TOKEN_ROTATED"),
			);
			return result;
		});
	});
