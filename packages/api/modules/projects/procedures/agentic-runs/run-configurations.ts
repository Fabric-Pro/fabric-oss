/**
 * Saved run configurations (mocks C8) — the named shapes the run dialog offers.
 *
 * A configuration says HOW a run executes, never WHICH cases. That split is the
 * whole point: a saved case list would go stale the moment somebody added a
 * case, and would keep looking like a regression suite while silently no longer
 * covering new work.
 *
 * Read is gated on TEST_CASE_READ and writes on TEST_CASE_UPDATE, matching the
 * run surfaces these configure rather than the project-settings surfaces they
 * resemble — someone who may start a run may name how they start it.
 */

import { ORPCError } from "@orpc/client";
import {
	createRunConfiguration,
	deleteRunConfiguration,
	ensureSystemRunConfiguration,
	listRunConfigurations,
	updateRunConfiguration,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPipelineResultsEnabled } from "../../lib/pipeline-results-feature";

/** Same closed sets the QA policy validates against. */
const browserSchema = z.enum(["chromium", "firefox", "webkit"]);
const resolutionSchema = z.string().regex(/^\d{3,5}x\d{3,5}$/, {
	message: "Use WIDTHxHEIGHT, e.g. 1920x1080",
});

export const listRunConfigurationsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/qa/run-configurations",
		tags: ["Projects", "Test Cases"],
		summary: "List saved configurations for Fabric-orchestrated runs",
	})
	.input(z.object({ projectId: z.string() }))
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		// Seeded on read, not at project creation, so projects that predate this
		// feature get one too. Without it the picker is empty everywhere, which
		// reads as broken rather than unconfigured.
		await ensureSystemRunConfiguration(input.projectId);
		return listRunConfigurations(input.projectId);
	});

export const createRunConfigurationProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/qa/run-configurations",
		tags: ["Projects", "Test Cases"],
		summary: "Save a reusable run configuration",
	})
	.input(
		z.object({
			projectId: z.string(),
			name: z.string().trim().min(1).max(120),
			environmentId: z.string().nullable().optional(),
			browser: browserSchema.nullable().optional(),
			resolution: resolutionSchema.nullable().optional(),
			runMode: z.enum(["MODE_A", "MODE_B"]).default("MODE_A"),
		}),
	)
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		try {
			return await createRunConfiguration(input);
		} catch {
			// The only constraint that can fail here is (projectId, name). Said as
			// a sentence rather than a raw Prisma violation, because the remedy is
			// "pick another name" and nothing else.
			throw new ORPCError("CONFLICT", {
				message: `A configuration called “${input.name}” already exists in this project.`,
			});
		}
	});

export const updateRunConfigurationProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "PUT",
		path: "/projects/{projectId}/qa/run-configurations/{configurationId}",
		tags: ["Projects", "Test Cases"],
		summary: "Update a saved run configuration",
	})
	.input(
		z.object({
			projectId: z.string(),
			configurationId: z.string(),
			name: z.string().trim().min(1).max(120).optional(),
			environmentId: z.string().nullable().optional(),
			browser: browserSchema.nullable().optional(),
			resolution: resolutionSchema.nullable().optional(),
			runMode: z.enum(["MODE_A", "MODE_B"]).optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		const updated = await updateRunConfiguration(input);
		if (!updated) {
			// Unknown id, or one belonging to another project. Same answer either
			// way — never confirm that an id exists somewhere else.
			throw new ORPCError("NOT_FOUND", {
				message: "Run configuration not found",
			});
		}
		return updated;
	});

export const deleteRunConfigurationProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/qa/run-configurations/{configurationId}",
		tags: ["Projects", "Test Cases"],
		summary: "Delete a saved run configuration",
	})
	.input(z.object({ projectId: z.string(), configurationId: z.string() }))
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		const result = await deleteRunConfiguration(input);
		if (result.reason === "NOT_FOUND") {
			throw new ORPCError("NOT_FOUND", {
				message: "Run configuration not found",
			});
		}
		if (result.reason === "SYSTEM") {
			// Refused rather than silently ignored: it is the guarantee that the
			// picker is never empty, and a project with no configuration at all
			// cannot start a run from this surface.
			throw new ORPCError("BAD_REQUEST", {
				message:
					"The project's default configuration cannot be deleted. Edit it instead, or add another alongside it.",
			});
		}
		return { success: true };
	});
