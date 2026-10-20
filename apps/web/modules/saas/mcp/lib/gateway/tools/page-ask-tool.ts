/**
 * Fabric MCP Gateway - Ask
 *
 * A page puts one question to Fabric and shows the answer, on the viewer's own
 * AI allowance. The model call is `answerPageQuestion` (`@repo/ai`): one call,
 * no tools, at most 1,024 tokens out, with the question and the context fenced
 * as untrusted. This module owns what that service leaves to its caller: that
 * the viewer can open the page, and ten questions a minute for one viewer on
 * one page.
 *
 * It is not a chat tool: the Fabric Agent is the model, so it has no use for
 * asking one. A call spends the viewer's allowance, so the tool is a write and
 * the host asks the viewer once per page version.
 */

import { errorResult, jsonResult } from "../tool-results";
import { pageTool, refuse } from "./page-store";

const FORMATS = ["text", "markdown", "json"] as const;
type AskFormat = (typeof FORMATS)[number];

function formatOf(value: unknown): AskFormat | undefined | null {
	if (value === undefined || value === null) {
		return undefined;
	}
	return FORMATS.find((format) => format === value) ?? null;
}

const handleAskPage = pageTool(
	{
		rate: "ask",
		parse: (args) => {
			const question =
				typeof args.question === "string" ? args.question : "";
			if (!question.trim()) {
				return refuse("question_empty", "`question` is required.");
			}
			const format = formatOf(args.format);
			if (format === null) {
				return refuse(
					"format",
					"`format` must be text, markdown or json.",
				);
			}
			return {
				ok: true,
				value: {
					question,
					context:
						typeof args.context === "string"
							? args.context
							: undefined,
					format,
				},
			};
		},
	},
	async ({ input, page, session }) => {
		const { answerPageQuestion, PageAskInputError } = await import(
			"@repo/ai"
		);
		try {
			const { answer, usage } = await answerPageQuestion({
				userId: session.userId,
				organizationId: page.organizationId,
				projectId: page.projectId,
				frameId: page.frameId,
				...input,
			});
			return jsonResult({ answer, usage });
		} catch (error) {
			if (error instanceof PageAskInputError) {
				return errorResult(error.message, { reason: error.problem });
			}
			const { AiUsageLimitExceededError } = await import(
				"@repo/payments"
			);
			if (error instanceof AiUsageLimitExceededError) {
				return errorResult(error.message, {
					reason: "usage_limit",
					manageLimitsUrl: error.manageLimitsUrl,
				});
			}
			console.error("[MCP Gateway] page ask failed:", {
				error: error instanceof Error ? error.message : error,
				stack: error instanceof Error ? error.stack : undefined,
			});
			return errorResult("The model could not answer right now.", {
				reason: "unavailable",
			});
		}
	},
);

export const PAGE_ASK_HANDLERS = new Map([["fabric_page_ask", handleAskPage]]);
