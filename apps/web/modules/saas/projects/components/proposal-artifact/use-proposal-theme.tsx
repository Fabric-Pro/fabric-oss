"use client";

import {
	PROPOSAL_THEME_ATTRIBUTE,
	PROPOSAL_THEME_CLASSES,
	proposalThemeCss,
} from "@repo/utils/proposal-artifact/proposal-theme";
import {
	buildProposalThemeTokens,
	type ProposalThemeTokens,
	resolveThemePaint,
	themeCustomProperties,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { orpcClient } from "@shared/lib/orpc-client";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { type CSSProperties, useMemo } from "react";
import { getOrpcCode } from "../field-mapping/orpc-error";

/**
 * What the theme root wears: the theme's class and target attribute, and the
 * paint as `--pa-*` custom properties. The stylesheet has no fallback
 * colours, so the properties always travel with the class.
 */
export type ProposalThemeRootProps = {
	className: string;
	[PROPOSAL_THEME_ATTRIBUTE]: "live";
	style: CSSProperties;
};

type ProposalTheme = {
	active: boolean;
	/** Spread onto the theme root; absent while the theme is off. */
	rootProps?: ProposalThemeRootProps;
};

/**
 * A refusal, not a fault: the gate is off for the owning organization, the
 * document is not a client-document Proposal, or the caller has no access to
 * the project. Asking again cannot change the answer.
 */
const DENIED_CODES = new Set(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"]);

function isThemeDenied(error: unknown): boolean {
	return DENIED_CODES.has(getOrpcCode(error) ?? "");
}

/**
 * Tokens change when someone edits the Style, the Brand kit or the recipient
 * brand, and only the Style tab on this page tells the query so itself
 * ({@link invalidateProposalTheme}); the recipient brand is also edited from
 * the project page and the Glossy page, and the Brand kit from settings. A
 * short freshness window lets the page pick those up when it is next shown.
 * The read is four narrow rows.
 */
const THEME_TOKENS_STALE_MS = 60_000;

/**
 * The signed logo reads the tokens carry last five minutes, so a page left
 * open asks again a minute before they lapse; a hidden tab waits until it is
 * shown, when the stale tokens are refetched anyway.
 */
const THEME_TOKENS_REFRESH_MS = 4 * 60_000;

function proposalThemeQueryKey(projectId: string, documentId?: string) {
	return [
		"projects",
		"proposalArtifact",
		"themeTokens",
		projectId,
		...(documentId ? [documentId] : []),
	] as const;
}

/**
 * Refetch the theme of every document in the project: the recipient brand is
 * the project's, and the Style is the edited document's.
 */
export function invalidateProposalTheme(
	queryClient: QueryClient,
	projectId: string,
): Promise<void> {
	return queryClient.invalidateQueries({
		queryKey: proposalThemeQueryKey(projectId),
	});
}

function rootPropsFor(
	tokens: ProposalThemeTokens<unknown>,
): ProposalThemeRootProps {
	return {
		className: PROPOSAL_THEME_CLASSES.root,
		[PROPOSAL_THEME_ATTRIBUTE]: "live",
		style: themeCustomProperties(
			resolveThemePaint(tokens),
		) as CSSProperties,
	};
}

/**
 * The neutral professional style, worn while the server's answer is on its
 * way so a Proposal's page does not flash unthemed first.
 */
const NEUTRAL_ROOT_PROPS = rootPropsFor(
	buildProposalThemeTokens({
		organization: null,
		style: null,
		brandKit: null,
		recipient: null,
	}),
);

/**
 * The shared theme a client-document Proposal wears on its live Main page
 * (Fizzy #2946), for organization members and project guests alike, so the
 * page matches the PDF exported later.
 *
 * The server decides. `enabled` (the page's own reading of the gate and the
 * document type) is only a provisional hint: while it holds and the answer
 * is pending the neutral paint is worn, a successful answer paints the
 * document's own tokens, and a refusal turns the theme off. A refetch that
 * fails for any other reason keeps the last answer rather than flashing the
 * page unthemed.
 */
export function useProposalTheme({
	projectId,
	documentId,
	enabled,
}: {
	projectId: string;
	documentId: string;
	enabled: boolean;
}): ProposalTheme {
	const query = useQuery({
		queryKey: proposalThemeQueryKey(projectId, documentId),
		queryFn: () =>
			orpcClient.projects.proposalArtifact.getThemeTokens({
				projectId,
				documentId,
			}),
		enabled,
		staleTime: THEME_TOKENS_STALE_MS,
		refetchInterval: THEME_TOKENS_REFRESH_MS,
		retry: (failureCount, error) =>
			!isThemeDenied(error) && failureCount < 2,
	});
	const tokens = query.data?.tokens;
	// Keyed on what the root paints, not on the tokens object: every refetch
	// signs fresh logo URLs, which must not re-render the editor beneath.
	const paintKey = tokens ? JSON.stringify(rootPropsFor(tokens).style) : null;
	const serverRootProps = useMemo(
		() => (tokens ? rootPropsFor(tokens) : undefined),
		[paintKey],
	);

	// A disabled query also reports itself pending, so the hint comes first.
	if (!enabled) {
		return { active: false };
	}
	if (query.isError && (isThemeDenied(query.error) || !serverRootProps)) {
		return { active: false };
	}
	if (serverRootProps) {
		return { active: true, rootProps: serverRootProps };
	}
	return { active: true, rootProps: NEUTRAL_ROOT_PROPS };
}

/** The static live stylesheet; brand values arrive on the root, never here. */
const LIVE_THEME_CSS = proposalThemeCss("live");

/**
 * The theme's live stylesheet. React hoists it into the document head and
 * keeps one copy however many theme roots render it.
 */
export function ProposalThemeStyle() {
	return (
		<style href="proposal-theme-live" precedence="default">
			{LIVE_THEME_CSS}
		</style>
	);
}
