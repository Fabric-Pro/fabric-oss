import { ORPCError } from "@orpc/client";
import { TEST_CASE_STATES, updateTestCase } from "@repo/database";
import { hasPermission } from "@repo/permissions";
import { normalizeQaPlaywrightScript } from "@repo/utils";
import { z } from "zod";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { enqueueTestCaseAutoSync } from "../../lib/enqueue-test-case-auto-sync";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";
import { automationInputFields } from "./automation-input";
import { mirrorTestCaseToContext } from "./sync-context";

const stepInputSchema = z.object({
	// Present when editing an existing step; omit to create a new one. The query
	// layer reconciles the full ordered list (delete-missing / update / create).
	id: z.string().optional(),
	action: z.string(),
	expected: z.string(),
});

export const updateTestCaseProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/test-cases/{testCaseId}",
		tags: ["Projects", "Test Cases"],
		summary: "Update a test case",
	})
	.input(
		z.object({
			projectId: z.string(),
			testCaseId: z.string(),
			organizationId: z.string().nullable().optional(),
			title: z.string().min(1).max(500).optional(),
			description: z.string().nullable().optional(),
			state: z.enum(TEST_CASE_STATES).optional(),
			priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
			ownerId: z.string().nullable().optional(),
			tags: z.array(z.string()).max(50).optional(),
			automationStatus: z
				.enum(["NOT_AUTOMATED", "PLANNED", "AUTOMATED"])
				.optional(),
			...automationInputFields,
			playwrightScript: z.string().max(100_000).nullable().optional(),
			pmAutoSyncEnabled: z.boolean().optional(),
			// Full ordered step list — replace semantics (omit to leave steps
			// untouched).
			steps: z.array(stepInputSchema).max(200).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_UPDATE) gates project
		// access.
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		let playwrightScript = input.playwrightScript;
		if (playwrightScript !== undefined) {
			const access = await resolveEffectiveProjectPermissions(
				input.projectId,
				user.id,
			);
			const canManageCredentialedScripts =
				access?.source === "owner" ||
				(access != null &&
					hasPermission(
						access.permissions,
						Permissions.PROJECT_SETTINGS_EDIT,
					));
			if (!canManageCredentialedScripts) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Only project admins or owners can change credentialed scripted tests.",
				});
			}
			if (playwrightScript?.trim()) {
				try {
					playwrightScript =
						normalizeQaPlaywrightScript(playwrightScript);
				} catch (error) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							error instanceof Error
								? error.message
								: "The scripted test is invalid.",
					});
				}
			}
		}

		const testCase = await updateTestCase({
			id: input.testCaseId,
			projectId: input.projectId,
			data: {
				title: input.title,
				description: input.description,
				state: input.state,
				priority: input.priority,
				ownerId: input.ownerId,
				tags: input.tags,
				// The query layer owns the automation-link rules (blank→null, and
				// a non-empty ref implying AUTOMATED unless this same request set
				// automationStatus explicitly) so they hold for every caller.
				automationStatus: input.automationStatus,
				automationRef: input.automationRef,
				automationFilePath: input.automationFilePath,
				automationExternalUrl: input.automationExternalUrl,
				playwrightScript,
				pmAutoSyncEnabled: input.pmAutoSyncEnabled,
				steps: input.steps,
			},
			actorUserId: user.id,
		});
		if (!testCase) {
			throw new ORPCError("NOT_FOUND", {
				message: "Test case not found",
			});
		}

		// Re-mirror the RAG context so the embedded body reflects the edit (AC7).
		await mirrorTestCaseToContext(testCase, {
			userId: user.id,
			organizationId,
		});

		// Auto-sync: a PM-linked case with `pmAutoSyncEnabled` pushes its edit to
		// the connected PM tool. Fire-and-forget — a sync hiccup must never fail
		// the edit (the helper swallows its own errors and no-ops for unlinked or
		// auto-sync-off cases).
		if (testCase.externalId && testCase.pmAutoSyncEnabled) {
			void enqueueTestCaseAutoSync({
				projectId: input.projectId,
				testCaseId: input.testCaseId,
				userId: user.id,
			});
		}

		return { testCase };
	});
