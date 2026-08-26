import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
	getProjectScanConfig,
	hasProjectAccess,
	recordScanActivity,
	upsertProjectScanConfig,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const CustomRuleSchema = z.object({
	id: z.string().optional(),
	name: z.string().min(1).max(120),
	category: z.enum(["SECURITY", "ACCESSIBILITY"]),
	severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
	guidance: z.string().min(1).max(2000),
	enabled: z.boolean().default(true),
});

// Editable severity rubric (G5) — one band definition per severity. The parser
// in @repo/database de-dupes by severity and falls back to seeded CVSS-aligned
// defaults when empty, so the band set need not be complete here.
const SeverityRubricEntrySchema = z.object({
	severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
	definition: z.string().min(1).max(2000),
});

// Optional attachable knowledge packs (G6) — richer security-review guidance
// appended to the scanner prompt. Knowledge text only (never executed). The DB
// parser caps an oversized `content`; the input bound here is a coarse guard.
const KnowledgePackSchema = z.object({
	id: z.string().optional(),
	title: z.string().min(1).max(200),
	content: z.string().min(1).max(20000),
	appliesTo: z.array(z.enum(["SECURITY", "ACCESSIBILITY"])).optional(),
});

export const updateScanConfigProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "PUT",
		path: "/projects/:projectId/scan/config",
		tags: ["Projects", "Security"],
		summary: "Update security & accessibility scan configuration",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			securityEnabled: z.boolean().optional(),
			accessibilityEnabled: z.boolean().optional(),
			semgrepEnabled: z.boolean().optional(),
			gitHistoryEnabled: z.boolean().optional(),
			// Auto-run the AI false-positive review as the scan's final phase.
			autoReviewFindings: z.boolean().optional(),
			// Which branch the repo-based scanners clone/scan. Blank /
			// whitespace-only normalizes to null (⇒ repository default branch)
			// in the query layer; `null` explicitly clears a set branch.
			scanBranch: z.string().max(255).nullable().optional(),
			enforcementMode: z.enum(["WARN", "BLOCK"]).optional(),
			autoScanOnMaturation: z.boolean().optional(),
			maturationGate: z
				.enum([
					"PLACEHOLDER",
					"PASSIVE_ANALYSIS",
					"ACTIVE_ANALYSIS",
					"SANITY_CHECK",
					"DRAFT",
					"PUBLISHED",
					"DECLINED",
					"CLOSED",
				])
				.optional(),
			customRules: z.array(CustomRuleSchema).max(100).optional(),
			// Severity rubric + knowledge packs apply on the NEXT scan; existing
			// findings are unchanged (the (i) note in the UI says as much).
			severityRubric: z
				.array(SeverityRubricEntrySchema)
				.max(8)
				.optional(),
			securityKnowledgePacks: z
				.array(KnowledgePackSchema)
				.max(50)
				.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const {
			projectId,
			organizationId,
			customRules,
			severityRubric,
			securityKnowledgePacks,
			...rest
		} = input;
		const user = context.user;

		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Capture the prior scan branch (only when the caller is touching it) so
		// the page-history entry can name a branch change specifically.
		const branchProvided = input.scanBranch !== undefined;
		const priorBranch = branchProvided
			? (await getProjectScanConfig(projectId)).scanBranch
			: null;

		// Ensure every custom rule carries a stable id for finding attribution.
		const normalizedRules = customRules?.map((r) => ({
			...r,
			id: r.id ?? randomUUID(),
		}));

		// Knowledge packs need a stable id too; the API accepts `appliesTo` as an
		// array for forward-compatibility, but the stored shape scopes a pack to a
		// single category, so collapse to the first entry (undefined ⇒ security,
		// the default). Logic that interprets the pack lives in @repo/database.
		const normalizedPacks = securityKnowledgePacks?.map((p) => ({
			id: p.id ?? randomUUID(),
			title: p.title,
			content: p.content,
			...(p.appliesTo && p.appliesTo.length > 0
				? { appliesTo: p.appliesTo[0] }
				: {}),
		}));

		const config = await upsertProjectScanConfig(projectId, {
			...rest,
			customRules: normalizedRules,
			severityRubric,
			securityKnowledgePacks: normalizedPacks,
			userId: user.id,
			organizationId: organizationId ?? undefined,
		});

		// Record the config change in the page history (best-effort) — the
		// History dialog advertises configuration changes, so emit them. When the
		// scan branch actually changed, say so specifically ("Set scan branch to
		// …" / "Cleared scan branch") so the history reflects the branch switch.
		const branchChanged =
			branchProvided && priorBranch !== config.scanBranch;
		const summary = branchChanged
			? config.scanBranch
				? `Set scan branch to "${config.scanBranch}"`
				: "Cleared scan branch"
			: "Updated scan configuration";
		await recordScanActivity({
			projectId,
			type: "CONFIG_UPDATED",
			userId: user.id,
			organizationId: organizationId ?? null,
			summary,
		}).catch(() => {});

		return { config };
	});
