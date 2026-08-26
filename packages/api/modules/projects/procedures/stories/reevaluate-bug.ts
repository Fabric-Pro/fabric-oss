/**
 * F-171 Re-evaluate Bug procedure (REQ-13, REQ-7, AC6, AC14)
 *
 * Re-runs the bug_reanalysis prompt against an existing BUG story. Replaces
 * the generic "Update using context" path for bug detail pages. Preserves
 * the "Original Description from User (Do Not Modify)" section verbatim
 * (enforced by the prompt itself plus a server-side guard) and always
 * re-evaluates the needsMoreInfo flag — which is the *only* way that flag
 * gets cleared per F-171 (no manual PM override, REQ-7).
 *
 * Caller flow: user types new info into the bug card description (the
 * normal description editor), saves, then clicks "Re-evaluate Bug". This
 * procedure re-runs the LLM against the current description and persists
 * the updated card.
 */

import { ORPCError } from "@orpc/client";
import { getLockedAttachmentRulesClause } from "@repo/agent-prompts";
import {
	AIProviderNotConfiguredError,
	generateObject,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
import { getProjectFunctionTagClause } from "@repo/ai/lib/function-tag-context";
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import { config } from "@repo/config";
import {
	buildFabricStoryUrl,
	db,
	getBoundPromptForAgent,
	getStoryById,
	placeFabricBackLink,
	setLastContextUpdateAt,
	updateStory,
} from "@repo/database";
import { logger } from "@repo/logs";
import { formatContextsForPrompt, retrieveProjectContexts } from "@repo/rag";
import {
	fetchLiveIntegrationContext,
	formatLiveContextForPrompt,
} from "@repo/rag/lib/project-contexts/live-integration-context";
import { getStorageProvider } from "@repo/storage";
import { renderTemplate, type TemplateFormat } from "@repo/utils";
import {
	findSectionEndIdx,
	stripInlineDecoration,
} from "@repo/utils/markdown-heading";
import { z } from "zod";
import {
	Permissions,
	requireOrganizationMembership,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { extractStoryMediaKeysFromContent } from "../../lib/extract-story-media-keys";
import { logReinjectedAttachments } from "../../lib/log-reinjected-attachments";
import { stripInternalStoryFields } from "../../lib/strip-internal-story-fields";

const ORIGINAL_DESCRIPTION_HEADER =
	"Original Description from User (Do Not Modify)";

/**
 * The `##` heading line the guard looks for, normalized and lower-cased once.
 * BOTH sides of the comparison in `findOriginalDescriptionHeaderIdx` run through
 * the same normalizer, so the target and the document line stay symmetric — a
 * header text that ever contained emphasis punctuation (`_`, `*`) would
 * otherwise be stripped on the document side only and stop matching.
 */
const ORIGINAL_DESCRIPTION_HEADING_LINE = stripInlineDecoration(
	`## ${ORIGINAL_DESCRIPTION_HEADER}`,
).toLowerCase();

/**
 * Index of the "Original Description from User (Do Not Modify)" heading line in
 * `lines`, or `-1`.
 *
 * The line is matched through `stripInlineDecoration` because this guard has to
 * survive the editor's inline decoration. Highlighting the heading stores
 * `## <mark data-color="#fef08a">Original Description from User (Do Not
 * Modify)</mark>`; bolding it stores `## **Original Description …**`. Against the
 * raw line both miss, the lookup returns `null`, and the verbatim-preserve guard
 * below silently FAILS OPEN — the model is then free to rewrite the reporter's
 * own words and nothing notices. That is a data-integrity failure, not a
 * formatting one.
 *
 * Normalizing also subsumes the old two-branch check (exact match, or the
 * all-lower-case spelling of the same constant) with a single case-insensitive
 * comparison, which is a strict superset of what matched before.
 *
 * The normalized string is used for the COMPARISON ONLY — it is lossy by design.
 * Both callers slice and re-join the ORIGINAL lines.
 */
function findOriginalDescriptionHeaderIdx(lines: string[]): number {
	return lines.findIndex(
		(line) =>
			stripInlineDecoration(line).toLowerCase() ===
			ORIGINAL_DESCRIPTION_HEADING_LINE,
	);
}

/**
 * Extracts the markdown body under the "Original Description from User (Do Not
 * Modify)" `##` header up to (but not including) the next top-level `## `
 * heading or EOF. Returns null when the header isn't present.
 *
 * The body is trimmed of leading/trailing whitespace so trivial reformatting
 * (extra blank lines) doesn't trip the verbatim check, while real edits
 * (rewording, deletion, truncation) do.
 *
 * Exported for unit test only — the procedure below is the sole caller.
 */
export function extractOriginalDescriptionBody(
	markdown: string,
): string | null {
	const lines = markdown.split("\n");
	const headerIdx = findOriginalDescriptionHeaderIdx(lines);
	if (headerIdx === -1) {
		return null;
	}
	return lines
		.slice(headerIdx + 1, findSectionEndIdx(lines, headerIdx))
		.join("\n")
		.trim();
}

/**
 * Replaces the body of the "Original Description from User (Do Not Modify)"
 * section in `markdown` with `originalBody`. Used when the LLM kept the
 * header but mutated the body — splice the user's verbatim text back in.
 *
 * The heading line itself is carried over UNCHANGED from `markdown`, decoration
 * and all: only the body between the boundaries is replaced.
 *
 * Exported for unit test only — the procedure below is the sole caller.
 */
export function spliceOriginalDescription(
	markdown: string,
	originalBody: string,
): string {
	const lines = markdown.split("\n");
	const headerIdx = findOriginalDescriptionHeaderIdx(lines);
	if (headerIdx === -1) {
		return markdown;
	}
	const before = lines.slice(0, headerIdx + 1);
	const after = lines.slice(findSectionEndIdx(lines, headerIdx));
	return [...before, "", originalBody, "", ...after].join("\n");
}

const ReanalyzedBugSchema = z.object({
	needsMoreInfo: z
		.boolean()
		.describe(
			"True only when the report is still too ambiguous to act on after the new info; false otherwise.",
		),
	markdown: z
		.string()
		.describe(
			"Full updated bug card markdown. MUST preserve the 'Original Description from User (Do Not Modify)' section exactly.",
		),
});

export const reevaluateBugProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/reevaluate-bug",
		tags: ["Projects", "Stories"],
		summary: "Re-evaluate a bug card",
		description:
			"Runs the bug_reanalysis prompt against the current bug description + new info, updates the card, and re-evaluates needsMoreInfo. Bugs only.",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			/**
			 * Optional new info to append alongside the existing card. Most
			 * callers will have already saved the new info into the bug's
			 * description before invoking this — pass extra context here only
			 * when it shouldn't be persisted to the description directly.
			 */
			newInfo: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (organizationId) {
			await requireOrganizationMembership(
				organizationId,
				context.user.id,
			);
		}
		const orgId = organizationId ?? undefined;

		const story = await getStoryById(input.storyId, input.projectId);
		if (!story) {
			throw new ORPCError("NOT_FOUND", { message: "Story not found" });
		}
		if (story.kind !== "BUG") {
			throw new ORPCError("BAD_REQUEST", {
				message:
					'"Re-evaluate Bug" is only valid for stories with kind=BUG.',
			});
		}

		const boundPrompt = await getBoundPromptForAgent({
			agentName: "bug_reanalyzer",
			documentType: "DRAFT",
			storyKind: "BUG",
			userId: user.id,
			organizationId: orgId,
		});
		if (!boundPrompt?.version?.content) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"bug_reanalysis prompt is not bound. Run the prompts seed.",
			});
		}

		const existingMarkdown = story.description ?? "";

		// Fetch supporting context the same way createStoryFromProposal does
		// so the re-analysis sees the same signals it had at creation time.
		const [ragSettled, liveSettled] = await Promise.allSettled([
			(async () => {
				const query = `${story.title} ${existingMarkdown}`.trim();
				const contexts = await retrieveProjectContexts({
					projectId: input.projectId,
					query,
					userId: user.id,
					organizationId: orgId,
					topK: 5,
				});
				return contexts.length > 0
					? formatContextsForPrompt(contexts)
					: null;
			})(),
			(async () => {
				const liveContext = await fetchLiveIntegrationContext({
					projectId: input.projectId,
					userId: user.id,
					organizationId: orgId,
					teamsLimit: 15,
					slackLimit: 15,
				});
				return formatLiveContextForPrompt(liveContext) || null;
			})(),
		]);

		const ragResult =
			ragSettled.status === "fulfilled" ? ragSettled.value : null;
		const liveResult =
			liveSettled.status === "fulfilled" ? liveSettled.value : null;

		const connectedContext = [ragResult ?? "", liveResult ?? ""]
			.filter(Boolean)
			.join("\n\n");

		const rendered = await renderTemplate({
			format: boundPrompt.format as TemplateFormat,
			template: boundPrompt.version.content,
			variables: {
				bug_title: story.title,
				bug_id_or_link: story.identifier,
				existing_bug_markdown: existingMarkdown,
				new_info_from_user_or_thread: input.newInfo ?? "",
				connected_context_items: connectedContext,
			},
		});
		if (rendered.error) {
			logger.warn(
				"[reevaluate-bug] prompt render returned an error; using raw body",
				{ error: rendered.error },
			);
		}

		// Fizzy #1767 Stage 4: resolve the project's function-tag
		// role-composition clause (flag-gated, self-authorizing — see
		// getProjectFunctionTagClause) so bug re-evaluation knows who's on
		// the project and in what capacity. No-op when the flag is off or no
		// roster member holds a tag.
		const roleClause = await getProjectFunctionTagClause({
			projectId: input.projectId,
			requesterUserId: user.id,
			surface: "reevaluate-bug",
		});

		let llmOutput: z.infer<typeof ReanalyzedBugSchema>;
		try {
			const { model, metadata, trackUsage } =
				await getAIModelWithMetadata(
					{ taskType: "COMPLEX" },
					{
						userId: user.id,
						organizationId: orgId,
						featureKey: "bug-reevaluation",
					},
				);
			const startedAt = Date.now();
			// FR-25: append the shared
			// locked-attachment rule so bug re-evaluation (triage) never
			// claims to have analysed an attachment or fabricates its
			// contents. Appended in code so it holds regardless of the
			// org-editable bound prompt. No-op today (no attachment
			// metadata reaches AI context).
			const prompt = `${rendered.rendered}\n\n${getLockedAttachmentRulesClause()}${roleClause ? `\n\n${roleClause}` : ""}`;
			// Scaled mode: the schema returns the FULL updated bug markdown, so
			// output tracks the existing card. Without an explicit budget
			// Databricks/Anthropic-direct truncate the rewrite at their injected
			// defaults; `undefined` for providers that don't need the workaround.
			const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
				inputChars: existingMarkdown.length,
				promptChars: prompt.length,
			});
			const { object, usage } = await generateObject({
				model,
				schema: ReanalyzedBugSchema,
				prompt,
				...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			});
			trackUsage();
			logModelUsageAsync({
				context: { userId: user.id, organizationId: orgId },
				metadata,
				taskType: "COMPLEX",
				usage,
				latencyMs: Date.now() - startedAt,
				projectId: input.projectId,
			});
			llmOutput = object;
		} catch (error) {
			if (error instanceof AIProviderNotConfiguredError) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message:
						"AI provider not configured. Please check your AI settings.",
				});
			}
			logger.error("[reevaluate-bug] LLM call failed", {
				error: error instanceof Error ? error.message : String(error),
				storyId: input.storyId,
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Re-evaluation failed. Please try again.",
			});
		}

		// REQ-7 / AC4 server-side guard: the prompt instructs the LLM to
		// preserve the "Original Description from User (Do Not Modify)"
		// section verbatim. Defense-in-depth — verify both that the header
		// is still present AND that the section *contents* match the prior
		// version. Keeping the header but rewriting the body would silently
		// corrupt the user's original report.
		// Only enforced when the section was present in the prior
		// description; pre-F-171 bugs may not have it yet.
		const originalBody = extractOriginalDescriptionBody(existingMarkdown);
		let finalMarkdown = llmOutput.markdown;
		if (originalBody !== null) {
			const llmBody = extractOriginalDescriptionBody(llmOutput.markdown);
			if (llmBody === null) {
				logger.error(
					"[reevaluate-bug] LLM dropped the Original Description section; rejecting",
					{ storyId: input.storyId },
				);
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message:
						"Re-analysis would have removed the original user description. Try again, or edit the description directly.",
				});
			}
			if (llmBody !== originalBody) {
				// LLM rewrote the body. Splice the original back in so the
				// rest of the re-analysis is preserved but the verbatim
				// requirement still holds.
				logger.warn(
					"[reevaluate-bug] LLM mutated Original Description body; restoring verbatim",
					{
						storyId: input.storyId,
						originalLen: originalBody.length,
						mutatedLen: llmBody.length,
					},
				);
				finalMarkdown = spliceOriginalDescription(
					llmOutput.markdown,
					originalBody,
				);
			}
		}

		// Spec §6 server-side guard: the augmentation in the
		// bug_reanalysis prompt instructs the model to preserve in-body
		// `story-media/<key>` images byte-for-byte across rewrites. When the
		// model still drops one (nondeterminism), reinject the missing keys
		// under an `## Attachments` heading so the user keeps both the
		// AI-improved card and the original images. Recovery action, not an
		// error — surface a structured warn and persist.
		const oldKeys = extractStoryMediaKeysFromContent(story.description);
		const newKeys = new Set(
			extractStoryMediaKeysFromContent(finalMarkdown),
		);
		const droppedKeys = oldKeys.filter((k) => !newKeys.has(k));

		if (droppedKeys.length > 0) {
			// Defense in depth: every reinjected key MUST belong to the
			// current story/project keyspace. Out-of-prefix keys should be
			// impossible (the keys were extracted from the existing
			// description which the tenant filter already validated), but a
			// silent skip + error log keeps the reinject path safe even if
			// upstream invariants ever drift.
			const expectedPrefix = `story-media/${input.projectId}/${input.storyId}/`;
			const safeKeys = droppedKeys.filter((key) => {
				if (key.startsWith(expectedPrefix)) {
					return true;
				}
				logger.error(
					"[stage-transition] skipped reinject of out-of-prefix key",
					{
						storyId: input.storyId,
						projectId: input.projectId,
						surface: "reevaluate-bug",
						key,
						expectedPrefix,
					},
				);
				return false;
			});

			if (safeKeys.length > 0) {
				const storageProvider = getStorageProvider();
				const bucket = config.storage.bucketNames.projectContexts;
				const signedResults = await Promise.allSettled(
					safeKeys.map((key) =>
						storageProvider.getSignedUrl(key, {
							bucket,
							expiresIn: 3600,
						}),
					),
				);

				// Pair each sign result back to its key so the recovery log
				// reports only the keys that actually landed in the persisted
				// description. A silent map+filter would let `droppedKeyCount`
				// drift above the number of `![]()` lines actually reinjected.
				const signedPairs: { key: string; url: string }[] = [];
				signedResults.forEach((result, index) => {
					const key = safeKeys[index];
					if (result.status === "fulfilled") {
						signedPairs.push({ key, url: result.value });
					} else {
						logger.error(
							"[stage-transition] failed to sign dropped attachment",
							{
								storyId: input.storyId,
								projectId: input.projectId,
								surface: "reevaluate-bug",
								key,
								err:
									result.reason instanceof Error
										? result.reason.message
										: String(result.reason),
							},
						);
					}
				});

				if (signedPairs.length > 0) {
					const attachmentsSection = [
						"",
						"## Attachments",
						"",
						...signedPairs.map(({ url }) => `![](${url})`),
					].join("\n");
					finalMarkdown = (finalMarkdown ?? "") + attachmentsSection;

					logReinjectedAttachments({
						storyId: input.storyId,
						projectId: input.projectId,
						surface: "reevaluate-bug",
						targetStage: null,
						draftingStage: story.draftingStage,
						droppedKeys: signedPairs.map(({ key }) => key),
					});
				}
			}
		}

		// Position the canonical "View in Fabric" back-link at the visual end
		// of the card. `placeFabricBackLink` strips every prior occurrence in
		// both description and acceptanceCriteria (the LLM may have kept it
		// inline, dropped it, or duplicated it), then puts a single canonical
		// anchor at the end of acceptanceCriteria when AC is non-empty, else
		// at the end of description. Soft-fail like createStory: a missing
		// back-link must not fail the AI flow.
		let finalAcceptanceCriteria = story.acceptanceCriteria;
		try {
			const project = await db.project.findUnique({
				where: { id: input.projectId },
				select: { organizationId: true },
			});
			const fabricUrl = await buildFabricStoryUrl({
				projectId: input.projectId,
				storyId: input.storyId,
				organizationId: project?.organizationId,
			});
			const placed = placeFabricBackLink({
				description: finalMarkdown,
				acceptanceCriteria: story.acceptanceCriteria,
				fabricUrl,
			});
			finalMarkdown = placed.description;
			finalAcceptanceCriteria = placed.acceptanceCriteria;
		} catch (e) {
			logger.warn(
				"[reevaluate-bug] Failed to re-place Fabric back-link",
				{
					error: e instanceof Error ? e.message : String(e),
					storyId: input.storyId,
				},
			);
		}

		const updatedStory = await updateStory(
			input.storyId,
			input.projectId,
			{
				description: finalMarkdown,
				acceptanceCriteria: finalAcceptanceCriteria,
				needsMoreInfo: llmOutput.needsMoreInfo,
			},
			{
				userId: user.id,
				organizationId,
				changedBy: user.id,
				changeDescription:
					"Re-evaluated bug via Re-evaluate Bug button",
				lastEditedSource: "AI_MATURATION",
				lastEditedByName: user.name ?? null,
			},
		);

		// Stamp the context update timer since Re-Evaluate Bug relies on external context
		void setLastContextUpdateAt({
			userStoryId: input.storyId,
			projectId: input.projectId,
			at: new Date(),
		}).catch((error) => {
			logger.warn(
				"[reevaluate-bug] Failed to stamp lastContextUpdateAt:",
				error,
			);
		});

		return {
			story: stripInternalStoryFields(updatedStory),
			needsMoreInfo: llmOutput.needsMoreInfo,
		};
	});
