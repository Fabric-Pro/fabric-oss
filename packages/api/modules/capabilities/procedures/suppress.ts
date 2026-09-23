/**
 * Silencing and restoring a warning (Fizzy #1930).
 *
 * Two procedures, one file, because they are one decision read in both
 * directions and splitting them invites the restore path to drift.
 *
 * The rule that shapes both: **only a warning can be silenced.** Every other
 * state is a statement about whether the capability can run, which is not a
 * viewer's to overrule. Suppression never satisfies a dependency, never changes
 * readiness, never unlocks a blocked action, and never reaches another person.
 * The read path enforces this too — it only ever applies a suppression to a
 * `WARNING` — so the guarantee holds even if a row is written by some future
 * caller that forgets.
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { gatherCapabilityEvidence } from "../evidence";
import { isCapabilityGatingEnabled } from "../flag";
import { CAPABILITY_RULES_BY_KEY } from "../registry";
import { resolveGate } from "../resolve";
import {
	expiryFor,
	parseSuppressions,
	SNOOZE_DURATIONS,
	serializeSuppressions,
	withoutSuppressions,
	withSuppression,
} from "../suppression";

const FLAG_OFF = "Capability gating is not enabled for this organization.";

/** Read the caller's stored map, or an empty one. */
async function readSuppressions(projectId: string, userId: string) {
	const row = await db.projectUserPreference.findUnique({
		where: { projectId_userId: { projectId, userId } },
		select: { capabilityWarningSuppressions: true },
	});
	return parseSuppressions(row?.capabilityWarningSuppressions);
}

export const suppressCapabilityWarningProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/capability-gates/suppress",
		tags: ["Projects", "Capabilities"],
		summary: "Dismiss or snooze a capability warning",
		description:
			"Hides one warning for the calling user on one project until it expires or its dependency materially changes.",
	})
	.input(
		z.object({
			projectId: z.string(),
			capabilityKey: z.string(),
			reasonKey: z.string(),
			// "session" is deliberately absent: a session dismissal lives in the
			// browser and dies with the tab, so storing one would create a row
			// nothing ever cleans up.
			duration: z.enum(
				SNOOZE_DURATIONS.filter((d) => d !== "session") as [
					string,
					...string[],
				],
			),
		}),
	)
	.output(z.object({ suppressed: z.boolean() }))
	.handler(async ({ input, context }) => {
		if (!(await isCapabilityGatingEnabled(input.projectId))) {
			throw new ORPCError("FORBIDDEN", { message: FLAG_OFF });
		}

		const rule = CAPABILITY_RULES_BY_KEY.get(input.capabilityKey);
		if (!rule) {
			throw new ORPCError("NOT_FOUND", {
				message: "Unknown capability.",
			});
		}

		// Re-resolve rather than trusting the client's claim about what it saw.
		// Between the render and the click the dependency may have got worse, and
		// silencing a block because it was a warning a moment ago is exactly the
		// failure the state ladder exists to prevent.
		const evidence = await gatherCapabilityEvidence({
			projectId: input.projectId,
			userId: context.user.id,
			organizationId:
				resolveOrganizationId(undefined, context.session) ?? null,
			includeAtlasStatus: input.capabilityKey.startsWith("atlas."),
		});
		const now = new Date();
		const gate = resolveGate(rule, evidence, now);

		if (gate.state !== "WARNING") {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Only a warning can be dismissed. This capability is currently blocked or still processing, and hiding that would not make it available.",
			});
		}
		if (gate.reasonKey !== input.reasonKey) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This warning has changed since it was shown. Reload to see the current state.",
			});
		}

		const existing = await readSuppressions(
			input.projectId,
			context.user.id,
		);
		const duration = input.duration as Exclude<
			(typeof SNOOZE_DURATIONS)[number],
			"session"
		>;
		const next = withSuppression(existing, {
			key: `${input.capabilityKey}:${input.reasonKey}`,
			// The resolved gate's own fingerprint, computed by the same
			// function the read path matches against.
			fingerprint: gate.fingerprint,
			expiresAt: expiryFor(duration, now),
			createdAt: now.toISOString(),
			duration,
		});

		await db.projectUserPreference.upsert({
			where: {
				projectId_userId: {
					projectId: input.projectId,
					userId: context.user.id,
				},
			},
			create: {
				projectId: input.projectId,
				userId: context.user.id,
				organizationId:
					resolveOrganizationId(undefined, context.session) ?? null,
				capabilityWarningSuppressions: serializeSuppressions(next, now),
			},
			update: {
				capabilityWarningSuppressions: serializeSuppressions(next, now),
			},
		});

		return { suppressed: true };
	});

export const restoreCapabilityWarningsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/capability-gates/restore",
		tags: ["Projects", "Capabilities"],
		summary: "Restore dismissed capability warnings",
		description:
			"Brings back the named dismissed warnings, or every warning the calling user has dismissed on this project.",
	})
	.input(
		z.object({
			projectId: z.string(),
			/**
			 * The warnings to bring back, each named by capability AND reason.
			 * Omit to restore everything this user silenced on this project; an
			 * empty list restores nothing.
			 *
			 * A list, taken in one write. Restoring several warnings as several
			 * calls raced on the one column they all rewrite, and the last
			 * write won.
			 */
			targets: z
				.array(
					z.object({
						capabilityKey: z.string(),
						reasonKey: z.string(),
					}),
				)
				.max(100)
				.optional(),
		}),
	)
	.output(z.object({ restored: z.boolean() }))
	.handler(async ({ input, context }) => {
		if (!(await isCapabilityGatingEnabled(input.projectId))) {
			throw new ORPCError("FORBIDDEN", { message: FLAG_OFF });
		}

		const existing = await readSuppressions(
			input.projectId,
			context.user.id,
		);
		const next = withoutSuppressions(
			existing,
			input.targets?.map(
				(target) => `${target.capabilityKey}:${target.reasonKey}`,
			),
		);

		await db.projectUserPreference.upsert({
			where: {
				projectId_userId: {
					projectId: input.projectId,
					userId: context.user.id,
				},
			},
			create: {
				projectId: input.projectId,
				userId: context.user.id,
				organizationId:
					resolveOrganizationId(undefined, context.session) ?? null,
				capabilityWarningSuppressions: {},
			},
			update: {
				capabilityWarningSuppressions: serializeSuppressions(
					next,
					new Date(),
				),
			},
		});

		return { restored: true };
	});
