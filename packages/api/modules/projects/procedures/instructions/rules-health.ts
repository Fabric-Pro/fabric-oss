import { ORPCError } from "@orpc/client";
import { generateText, getAIModelWithMetadata, Output } from "@repo/ai";
import { requireStructuredOutput } from "@repo/ai/lib/structured-output";
import { config } from "@repo/config";
import {
	getPublishedInstructionSnapshot,
	listInstructionFiles,
} from "@repo/database";
import {
	analyzeRules,
	healthRuleFindings,
	isRuleFilePath,
	type RuleFinding,
	type RuleSource,
	validateReviewFindings,
} from "@repo/instructions";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { readDirectRepositoryFilesForApi } from "./repository/direct-batch";
import { listDirectRepositoryFilesForApi } from "./repository/direct-query";

/**
 * Rules health (specs/2026-10-21-ai-artifacts-hub §5.8). `rulesHealth` reads
 * the project's rule files, from its repository when Coding Instructions read
 * from one, else from the published version, and reports how much of a
 * session they take and what is duplicated, too long or past the always-on
 * budget. `reviewRules` asks the model for what a rule-by-rule check cannot
 * see: contradictions, vague rules, merges, and rules better kept as checks,
 * and answers with the checks' findings and the model's together, in the
 * shared categories (`@repo/instructions` rule-findings), so the panel, the
 * review and the suggested edits count the same files.
 *
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * INSTRUCTION_READ; the repository reads repeat their own checks.
 */

const BUCKET = config.storage.bucketNames.skills;
const MAX_RULES = 200;
/** The most rule text one model call is given, whole files only. */
const MAX_REVIEW_CHARS = 60_000;

const input = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

/**
 * The version the rules were read from, in the shape every instruction change
 * names its base with: the pinned repository head, or the published snapshot.
 */
export type RulesBase =
	| { nativeBase: { generation: number; commitSha: string } }
	| { baseSnapshotId: string };

export async function readRules(
	projectId: string,
	userId: string,
	organizationId: string,
): Promise<{
	source: "repository" | "published" | "none";
	rules: RuleSource[];
	base: RulesBase | null;
}> {
	// A project that reads its instructions from a repository: its pinned head.
	let listing: Awaited<
		ReturnType<typeof listDirectRepositoryFilesForApi>
	> | null = null;
	try {
		listing = await listDirectRepositoryFilesForApi({ projectId, userId });
	} catch {
		listing = null;
	}
	if (listing) {
		const paths = listing.files
			.map((file) => file.path)
			.filter(isRuleFilePath)
			.slice(0, MAX_RULES);
		const rules: RuleSource[] = [];
		let start: number | null = paths.length > 0 ? 0 : null;
		while (start !== null) {
			const batch = await readDirectRepositoryFilesForApi({
				projectId,
				userId,
				generation: listing.generation,
				commitSha: listing.commitSha,
				paths,
				startIndex: start,
			});
			for (const file of batch.files) {
				if (file.read.state === "found") {
					rules.push({ path: file.path, text: file.read.text });
				}
			}
			start = batch.nextIndex;
		}
		return {
			source: "repository",
			rules,
			base: {
				nativeBase: {
					generation: listing.generation,
					commitSha: listing.commitSha,
				},
			},
		};
	}

	const snapshot = await getPublishedInstructionSnapshot(projectId);
	if (!snapshot) {
		return { source: "none", rules: [], base: null };
	}
	const files = (await listInstructionFiles(snapshot.id, organizationId))
		.filter((file) => file.isText && isRuleFilePath(file.path))
		.slice(0, MAX_RULES);
	const storage = getStorageProvider();
	const rules = await Promise.all(
		files.map(async (file) => {
			const { data } = await storage.downloadFile(file.storageKey, {
				bucket: BUCKET,
			});
			return { path: file.path, text: data.toString("utf8") };
		}),
	);
	return {
		source: "published",
		rules,
		base: { baseSnapshotId: snapshot.id },
	};
}

export const rulesHealthProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/rules-health",
		tags: ["Projects", "Instructions"],
		summary:
			"How much of a session the project's rules take, and what to clean up",
	})
	.input(input)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const { source, rules } = await readRules(
			input.projectId,
			context.user.id,
			organizationId,
		);
		return { source, ...analyzeRules(rules) };
	});

/**
 * The rules one model call is given: whole files in order, until the next one
 * would pass `MAX_REVIEW_CHARS`. A file is never cut, so whatever the model
 * rewrites, it rewrites from the whole text.
 */
export function boundRuleBlocks(
	rules: readonly RuleSource[],
): Array<{ rule: RuleSource; block: string }> {
	let used = 0;
	const out: Array<{ rule: RuleSource; block: string }> = [];
	for (const rule of rules) {
		const block = `### ${rule.path}
${rule.text}`;
		if (used + block.length > MAX_REVIEW_CHARS) {
			break;
		}
		out.push({ rule, block });
		used += block.length;
	}
	return out;
}

const REVIEW_PROMPT = `You review the coding rules an AI coding agent follows in one software project. Report only what a reader cannot see one rule at a time, as findings, each in one category:
- overlap: rules that repeat each other and should be merged (give the merged wording), or that contradict each other (quote the conflicting lines).
- vague: a rule an agent cannot act on, with a concrete rewrite.
- narrower-scope: a rule that belongs to a narrower scope, with the paths: glob to give it.
- better-enforced: a rule better enforced by a linter, formatter, test or hook than by text.
Give each finding the exact paths of the rule files it is about and a short summary (Markdown allowed). Leave a category out when nothing fits it; never report the always-on budget or duplicates, the checks already do. Never invent rules or facts that are not in the input.`;

/**
 * What the review model answers. Every field required, so the schema stays
 * valid for providers' strict structured output; the category is free text
 * here and checked against the shared set afterwards, so one unknown
 * category drops one finding, not the whole review.
 */
export const RULES_REVIEW_SCHEMA = z.object({
	findings: z.array(
		z.object({
			category: z.string(),
			files: z.array(z.string()),
			summary: z.string(),
		}),
	),
});

export const reviewRulesProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/rules-review",
		tags: ["Projects", "Instructions"],
		summary:
			"AI review of the project's rules: contradictions, merges, scope",
	})
	.input(input)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const { rules } = await readRules(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (rules.length === 0) {
			return { findings: [] as RuleFinding[] };
		}
		const checks = healthRuleFindings(analyzeRules(rules).findings);
		const given = boundRuleBlocks(rules);
		const blocks = given.map((b) => b.block);
		try {
			const { model, trackUsage } = await getAIModelWithMetadata(
				{ taskType: "SIMPLE", complexity: "medium" },
				{
					userId: context.user.id,
					organizationId,
					projectId: input.projectId,
					jobType: "context-summarization",
				},
			);
			const result = await requireStructuredOutput(
				generateText({
					model,
					instructions: REVIEW_PROMPT,
					prompt: `Rules (${blocks.length} of ${rules.length} files):\n\n${blocks.join("\n\n")}`,
					output: Output.object({ schema: RULES_REVIEW_SCHEMA }),
				}),
			);
			trackUsage();
			const raw = RULES_REVIEW_SCHEMA.parse(result.output);
			const findings: RuleFinding[] = [
				...checks,
				...validateReviewFindings(
					raw.findings,
					given.map((g) => g.rule.path),
				),
			];
			return { findings };
		} catch (error) {
			logger.warn("[instructions.reviewRules] model call failed", {
				error: error instanceof Error ? error.name : typeof error,
			});
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message:
					"The AI review is unavailable: check the organization's AI provider settings. The checks above do not need it.",
			});
		}
	});
