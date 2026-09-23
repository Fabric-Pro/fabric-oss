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

import { db } from "@repo/database";
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
import { isCapabilityGatingEnabled } from "../flag";
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
	"roadmap",
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
			"CONFIGURE_PM_BOARD",
			"ENABLE_CODE_SEARCH",
			"RETRY_JOB",
			"WAIT",
		])
		.nullable(),
	retry: z.object({
		supported: z.boolean(),
		permitted: z.boolean(),
		available: z.boolean(),
		targetId: z.string().nullable(),
	}),
	suppressed: z.boolean(),
	fingerprint: z.string(),
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
			/**
			 * Narrow to several surfaces in one read — what a page that mounts
			 * more than one gated surface asks for. Combined with `surface`
			 * when both are given; with neither, the whole matrix.
			 */
			surfaces: z.array(z.enum(SURFACES)).optional(),
		}),
	)
	.output(z.object({ enabled: z.boolean(), gates: z.array(gateSchema) }))
	.handler(async ({ input, context }) => {
		// Off means off everywhere: no resolution here, and no assert at the
		// mutating doors either. Gating only the render would leave an action
		// blocked after the flag was turned off, which is the opposite of what a
		// rollback lever is for. Resolved for the project's own organization —
		// the same answer the doors reach — and this is the `enabled` value
		// the client trusts to decide whether to draw anything at all.
		if (!(await isCapabilityGatingEnabled(input.projectId))) {
			return { enabled: false, gates: [] };
		}

		const requested: ReadonlySet<CapabilitySurface> | null =
			input.surface || input.surfaces
				? new Set([
						...(input.surface ? [input.surface] : []),
						...(input.surfaces ?? []),
					])
				: null;

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
				// Atlas's status accessor reaches the git provider over HTTP,
				// may refresh a credential and can write an audit row, so it
				// is paid for only when the Atlas surface is asked for BY NAME.
				// Not for the whole matrix: that read is what a project page
				// makes on load and after mutations, and it would otherwise
				// make a third-party call each time for two gates no page
				// renders. Without it the Atlas gates answer from rows alone,
				// at the cost stated on `includeAtlasStatus`.
				includeAtlasStatus: requested?.has("atlas") ?? false,
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
		const rules = requested
			? CAPABILITY_RULES.filter((rule) => requested.has(rule.surface))
			: CAPABILITY_RULES;

		const gates: CapabilityGate[] = rules.map((rule) =>
			resolveGate(rule, evidence, now, suppressions),
		);

		return { enabled: true, gates };
	});
