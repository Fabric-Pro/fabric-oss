/**
 * Fizzy account_slug fallback resolver.
 *
 * Fizzy MCP tools (`fizzy_get_card`, `fizzy_get_cards`, etc.) require an
 * `account_slug` parameter. It's normally stored on the project's
 * `projectManagementAdditionalContext` JSON blob and threaded through to
 * activity inputs as `additionalContext.account_slug`. But projects created
 * before this field was wired up — or projects where PM settings were saved
 * without re-selecting the board — have it missing, and every Fizzy MCP call
 * fails with "Account slug is required" (observed live: 117 such failures in
 * 45 min on staging).
 *
 * This helper provides the same fallback used inside `listWorkItemsFromPM`
 * (see story-sync.ts lines 3890+) but as a standalone shared function so
 * `fetchPMItemsByIds` (which previously had NO fallback and was the source
 * of every failure) — plus any future Fizzy-touching activity — can call it
 * without re-implementing the resolution.
 *
 * The resolution probes the MCP server for a Fizzy accounts/identity tool
 * and takes the first account's slug. Safe to call when `additionalContext`
 * already has a slug — it returns the existing value unchanged.
 */
import { executeMcpTool } from "../orchestrator/execution/execute-mcp-tool";
import { parseMcpArrayFromOutput } from "./story-sync";

interface ResolveFizzyAccountSlugInput {
	toolName: string;
	availableTools: readonly string[];
	additionalContext: Record<string, string> | undefined;
	mcpConfigId: string;
	userId: string;
	organizationId?: string;
	/** Opt-in per-probe timeout (ms). Forwarded as `timeoutMs`. */
	callTimeoutMs?: number;
}

export interface ResolveFizzyAccountSlugResult {
	additionalContext: Record<string, string>;
	resolvedSlug?: string;
}

/**
 * If the tool name looks like a Fizzy tool AND `additionalContext` doesn't
 * already have an account_slug, probe `fizzy_get_accounts` (or
 * `fizzy_get_identity`) for one and merge it into the returned context.
 *
 * Non-fizzy tools and contexts that already have a slug return the original
 * context unchanged (zero MCP calls). MCP errors during the probe are
 * swallowed — the caller's subsequent tool call will produce a clearer
 * "account_slug is required" failure with a context the user can act on.
 */
export async function resolveFizzyAccountSlug(
	input: ResolveFizzyAccountSlugInput,
): Promise<ResolveFizzyAccountSlugResult> {
	const ctx = input.additionalContext ?? {};
	const isFizzy = /fizzy/i.test(input.toolName);
	const alreadyHasSlug = !!ctx.account_slug || !!ctx.slug;

	if (!isFizzy || alreadyHasSlug) {
		return { additionalContext: ctx };
	}

	const tryFetchAccounts = async (
		toolName: string,
	): Promise<string | null> => {
		try {
			const result = await executeMcpTool({
				toolName,
				args: {},
				userId: input.userId,
				organizationId: input.organizationId,
				mcpConfigId: input.mcpConfigId,
				timeoutMs: input.callTimeoutMs,
			});
			if (!result.success || !result.output) {
				return null;
			}
			const accounts = parseMcpArrayFromOutput(result.output);
			const first = accounts[0] as Record<string, unknown> | undefined;
			if (!first) {
				return null;
			}
			// Fizzy accounts may expose the slug under several keys depending on
			// MCP server version — try each.
			const slug = String(
				first.slug ?? first.account_slug ?? first.id ?? first.key ?? "",
			);
			return slug || null;
		} catch {
			return null;
		}
	};

	const accountsTool = input.availableTools.find(
		(name) =>
			/fizzy_(?:get|list)_accounts?$/i.test(name) ||
			/(?:get|list)_accounts?$/i.test(name),
	);
	const identityTool = input.availableTools.find((name) =>
		/fizzy_get_identity$/i.test(name),
	);

	let slug: string | null = null;
	if (accountsTool) {
		slug = await tryFetchAccounts(accountsTool);
	}
	if (!slug && identityTool) {
		slug = await tryFetchAccounts(identityTool);
	}

	if (!slug) {
		return { additionalContext: ctx };
	}

	return {
		additionalContext: { ...ctx, account_slug: slug },
		resolvedSlug: slug,
	};
}
