import {
	getProjectQaSettings,
	PIPELINE_SYNC_INTERVAL_MINUTES,
	QA_SCEPTIC_ROLES,
	upsertProjectQaSettings,
} from "@repo/database";
import { QA_TEST_TYPES } from "@repo/utils/qa-test-types";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/** `1920x1080` — the only resolution shape the run config knows how to use. */
const resolutionSchema = z
	.string()
	.regex(/^\d{3,5}x\d{3,5}$/, "Use WIDTHxHEIGHT, e.g. 1920x1080");

/**
 * Read the project's QA policy. Returns defaults (with `configured: false`) when
 * the project has never saved, so the page always renders real values and
 * viewing never writes a row.
 */
export const getProjectQaSettingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/qa-settings",
		tags: ["Projects", "Test Cases"],
		summary: "Get the project's QA policy (Settings ▸ Testing)",
	})
	.input(z.object({ projectId: z.string() }))
	.handler(async ({ input }) => getProjectQaSettings(input.projectId));

/**
 * Update the project's QA policy. Every field is optional — the page saves the
 * section the user touched, and omitted fields keep their stored value rather
 * than being blanked.
 */
export const updateProjectQaSettingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "PUT",
		path: "/projects/{projectId}/qa-settings",
		tags: ["Projects", "Test Cases"],
		summary: "Update the project's QA policy",
	})
	.input(
		z.object({
			projectId: z.string(),
			strategyDepth: z.enum(["EASY", "AVERAGE", "HARD"]).optional(),
			// Constrained to known kinds for the same reason as `scepticRoles`
			// below: the list reaches a drafting prompt, and a stored typo would
			// become an instruction. An empty array is meaningful — it means
			// "follow the depth tier" — so it is deliberately not rejected.
			requiredTestTypes: z.array(z.enum(QA_TEST_TYPES)).optional(),
			// Percentages are bounded here as well as in the UI: the slider can't
			// send 250, but a direct API call could.
			confidenceThreshold: z.number().int().min(0).max(100).optional(),
			indexCoverageEnabled: z.boolean().optional(),
			coverageTarget: z.number().int().min(0).max(100).optional(),
			// 0 disables the gate. Capped at 10 because a threshold nobody can
			// reach is a footgun, not a policy — a project with 4 members cannot
			// satisfy 20 and would be permanently unable to mark anything done.
			requiredQaSignOffs: z.number().int().min(0).max(10).optional(),
			resolutions: z.array(resolutionSchema).max(20).optional(),
			browsers: z
				.array(z.enum(["chromium", "firefox", "webkit"]))
				.max(3)
				.optional(),
			rulesMarkdown: z.string().max(20000).nullable().optional(),
			implementationNotes: z.string().max(20000).nullable().optional(),
			evidencePolicy: z
				.enum(["SCREENSHOT_REQUIRED", "OPTIONAL", "NONE"])
				.optional(),
			// 0 = keep indefinitely. Capped at ten years: a larger number is a typo,
			// and an uncapped one silently disables the sweep it configures.
			evidenceRetentionDays: z.number().int().min(0).max(3650).optional(),
			scepticRolesEnabled: z.boolean().optional(),
			// Constrained to known role keys so a typo can't silently persist a
			// role no agent will ever read.
			scepticRoles: z.array(z.enum(QA_SCEPTIC_ROLES)).optional(),
			defaultEnvironmentId: z.string().nullable().optional(),
			// Which PR review lenses this project runs. Both
			// default ON in the query layer, so omitting them here leaves an
			// unconfigured project running both, as it did before they existed.
			prReviewQaLensEnabled: z.boolean().optional(),
			prReviewArchitectureLensEnabled: z.boolean().optional(),
			// Automatic review on every pull request. Off unless a project opts in
			// — see the column's own comment.
			prReviewAutoReviewEnabled: z.boolean().optional(),
			// Bounded like the other free-text policy fields. A rule set nobody
			// can read is a rule set nobody maintains.
			architectureRules: z.string().max(20000).nullable().optional(),
			// Automatic pipeline-result sync. The interval is validated
			// against the same closed set the query enforces and the form offers,
			// so a direct API call cannot store a cadence nothing will honour —
			// and cannot ask for one so short it DoSes the customer's own CI.
			pipelineSyncEnabled: z.boolean().optional(),
			pipelineSyncIntervalMinutes: z
				.number()
				.int()
				.refine(
					(m) =>
						(
							PIPELINE_SYNC_INTERVAL_MINUTES as readonly number[]
						).includes(m),
					{
						message: `Interval must be one of ${PIPELINE_SYNC_INTERVAL_MINUTES.join(", ")} minutes`,
					},
				)
				.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// Tenant columns are copied from the PARENT PROJECT inside the query, not
		// taken from caller input: `requireProjectPermission` authorizes the
		// project but never looks at the organization, so trusting an input org
		// would let a caller pair a project they can reach with an organization
		// they don't belong to (SOC 2 CC6.1/CC6.3).
		const settings = await upsertProjectQaSettings(input);
		const changedFields = Object.keys(input).filter(
			(field) => field !== "projectId",
		);
		recordAuditFromRequest(context, {
			action: "project.qa_settings.updated",
			category: "project",
			severity: input.evidencePolicy === "NONE" ? "warning" : "info",
			outcome: "success",
			projectId: input.projectId,
			resource: { type: "project_qa_settings", id: input.projectId },
			metadata: {
				changedFields,
				evidencePolicyDisabled: input.evidencePolicy === "NONE",
				rulesChanged: input.rulesMarkdown !== undefined,
				implementationNotesChanged:
					input.implementationNotes !== undefined,
			},
		});
		return settings;
	});
