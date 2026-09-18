/**
 * Every capability gate for one project, from the caller's point of view.
 *
 * ## Why one procedure rather than a field on nine existing ones
 *
 * The obvious alternative — attach a `gate` to each surface's existing output —
 * fails silently in this codebase. An oRPC `.output()` schema strips fields it
 * does not declare, so the server would send gates, the schema would drop them,
 * both halves would type-check, every test would pass, and the client would
 * render nothing with nothing joining the two. One procedure with one schema
 * has no such gap, and it also means a page pays for one resolution rather than
 * nine.
 *
 * "From the caller's point of view" is not decoration: retry permission and
 * warning suppression are both per-viewer, so two people on the same project at
 * the same second can legitimately see different gates.
 */

import { db, isFeatureEnabled } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	CapabilityEvidenceUnavailableError,
	gatherCapabilityEvidence,
} from "../evidence";
import { CAPABILITY_RULES } from "../registry";
import { resolveGate } from "../resolve";
import { parseSuppressions } from "../suppression";
import type { CapabilityGate, CapabilitySurface } from "../types";

const SURFACES = [
	"documents",
	"context",
	"atlas",
	"security",
	"release-notes",
	"settings",
] as const satisfies readonly CapabilitySurface[];

const gateSchema = z.object({
	capabilityKey: z.string(),
	state: z.enum([
		"HARD_BLOCK",
		"SOFT_BLOCK",
		"PROCESSING",
		"WARNING",
		"AVAILABLE",
		"HIDDEN",
	]),
	reasonKey: z.string().nullable(),
	blockingDependency: z.string().nullable(),
	remedy: z
		.enum([
			"CONNECT_REPOSITORY",
			"RECONNECT_CREDENTIAL",
			"INSTALL_REPOSITORY_APP",
			"ADD_CONTEXT",
			"GENERATE_PREREQUISITE_DOCUMENT",
			"CONFIGURE_INTEGRATION",
			"RETRY_JOB",
			"WAIT",
		])
		.nullable(),
	retry: z.object({
		supported: z.boolean(),
		permitted: z.boolean(),
		available: z.boolean(),
	}),
	suppressed: z.boolean(),
});

export const getCapabilityGatesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/capability-gates",
		tags: ["Projects", "Capabilities"],
		summary: "Get capability gates",
		description:
			"Resolved availability for every setup-dependent capability on a project, computed from live system state.",
	})
	.input(
		z.object({
			projectId: z.string(),
			/** Narrow to one surface so a page does not pay for the whole matrix. */
			surface: z.enum(SURFACES).optional(),
		}),
	)
	.output(z.object({ enabled: z.boolean(), gates: z.array(gateSchema) }))
	.handler(async ({ input, context }) => {
		// Off means off everywhere: no resolution here, and no assert at the
		// mutating doors either. Gating only the render would leave an action
		// blocked after the flag was turned off, which is the opposite of what a
		// rollback lever is for.
		if (!(await isFeatureEnabled("CAPABILITY_GATING"))) {
			return { enabled: false, gates: [] };
		}

		// A project that cannot be resolved yields no gates rather than an error
		// page. The asymmetry with the mutating doors is deliberate and is the
		// whole safety argument: THIS path only decides what to draw, so failing
		// open costs a missing explanation, while the doors do not catch the same
		// error and therefore still refuse the work. A degraded drawing is a
		// smaller harm than a project page that will not load because an
		// explanation could not be computed.
		let evidence: Awaited<ReturnType<typeof gatherCapabilityEvidence>>;
		try {
			evidence = await gatherCapabilityEvidence({
				projectId: input.projectId,
				userId: context.user.id,
				organizationId:
					resolveOrganizationId(undefined, context.session) ?? null,
				// Atlas's status accessor reaches the git provider over HTTP, so
				// it is paid for only when an Atlas gate is actually being
				// resolved. Every other surface answers from rows alone, which
				// is why a project page no longer makes a third-party call just
				// to decide what to draw.
				includeAtlasStatus:
					input.surface === undefined || input.surface === "atlas",
			});
		} catch (error) {
			if (error instanceof CapabilityEvidenceUnavailableError) {
				return { enabled: true, gates: [] };
			}
			throw error;
		}

		const preference = await db.projectUserPreference.findUnique({
			where: {
				projectId_userId: {
					projectId: input.projectId,
					userId: context.user.id,
				},
			},
			select: { capabilityWarningSuppressions: true },
		});
		const suppressions = parseSuppressions(
			preference?.capabilityWarningSuppressions,
		);

		const now = new Date();
		const rules = input.surface
			? CAPABILITY_RULES.filter((rule) => rule.surface === input.surface)
			: CAPABILITY_RULES;

		const gates: CapabilityGate[] = rules.map((rule) =>
			resolveGate(rule, evidence, now, suppressions),
		);

		return { enabled: true, gates };
	});
