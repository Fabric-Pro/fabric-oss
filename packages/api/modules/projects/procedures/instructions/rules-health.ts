import { ORPCError } from "@orpc/client";
import { generateText, getAIModelWithMetadata } from "@repo/ai";
import { config } from "@repo/config";
import {
	getPublishedInstructionSnapshot,
	listInstructionFiles,
} from "@repo/database";
import {
	analyzeRules,
	isRuleFilePath,
	type RuleSource,
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
 * see: contradictions, vague rules, merges, and rules better kept as checks.
 *
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * INSTRUCTION_READ; the repository reads repeat their own checks.
 */

const BUCKET = config.storage.bucketNames.skills;
const MAX_RULES = 200;
const MAX_REVIEW_CHARS = 60_000;

const input = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

async function readRules(
	projectId: string,
	userId: string,
	organizationId: string,
): Promise<{
	source: "repository" | "published" | "none";
	rules: RuleSource[];
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
		return { source: "repository", rules };
	}

	const snapshot = await getPublishedInstructionSnapshot(projectId);
	if (!snapshot) {
		return { source: "none", rules: [] };
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
	return { source: "published", rules };
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

const REVIEW_PROMPT = `You review the coding rules an AI coding agent follows in one software project. Report only what a reader cannot see one rule at a time:
- Contradictions: rules that require opposite things (name both files and quote the conflicting lines).
- Overlap: rules that should be merged, with the merged wording.
- Vague rules an agent cannot act on, with a concrete rewrite.
- Rules that belong to a narrower scope: suggest a paths: glob.
- Rules better enforced by a linter, formatter, test or hook than by text.
Write short markdown sections in that order, omit empty sections, cite files by path. Never invent rules or facts that are not in the input.`;

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
			return { review: "This project has no rule files to review." };
		}
		let used = 0;
		const blocks: string[] = [];
		for (const rule of rules) {
			const block = `### ${rule.path}\n${rule.text}`;
			if (used + block.length > MAX_REVIEW_CHARS) {
				break;
			}
			blocks.push(block);
			used += block.length;
		}
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
			const result = await generateText({
				model,
				instructions: REVIEW_PROMPT,
				prompt: `Rules (${blocks.length} of ${rules.length} files):\n\n${blocks.join("\n\n")}`,
			});
			trackUsage();
			return { review: result.text.trim() };
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
