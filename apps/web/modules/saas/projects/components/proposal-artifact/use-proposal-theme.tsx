"use client";

import {
	PROPOSAL_THEME_ATTRIBUTE,
	PROPOSAL_THEME_CLASSES,
	proposalThemeCss,
} from "@repo/utils/proposal-artifact/proposal-theme";
import {
	buildProposalThemeTokens,
	NEUTRAL_THEME,
	type ProposalThemePaint,
	resolveThemePaint,
	safeFontFamily,
	themeCustomProperties,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { orpcClient } from "@shared/lib/orpc-client";
import { type QueryClient, skipToken, useQuery } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { getOrpcCode } from "../field-mapping/orpc-error";
import { PROPOSAL_FONT_VARIABLES } from "./proposal-fonts";

/**
 * What the theme root wears: the theme's class and target attribute, the
 * classes that load its display and mono faces, and the paint as `--pa-*`
 * custom properties. The stylesheet has no fallback colours, so the
 * properties always travel with the class.
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
	/**
	 * The resolved paint the root wears, for what draws its own colours:
	 * the live diagrams' role classes. Absent while the theme is off.
	 */
	paint?: ProposalThemePaint;
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

type ThemeFontSlot = "display" | "body";

/** The custom property each uploaded font's family is written to. */
const THEME_FONT_PROPERTIES = {
	display: "--pa-font-display",
	body: "--pa-font-body",
} as const satisfies Record<ThemeFontSlot, `--pa-${string}`>;

/**
 * A file is read by its id and a new upload arrives under a new id, so the
 * bytes never go stale; they are kept a day for a page opened again.
 */
const THEME_FONT_GC_MS = 24 * 60 * 60_000;

/**
 * Outside the tokens' key, so refetching or invalidating the theme does not
 * read the font again.
 */
function proposalThemeFontQueryKey(
	projectId: string,
	documentId: string,
	slot: ThemeFontSlot,
	fileId: string | null,
) {
	return [
		"projects",
		"proposalArtifact",
		"themeFont",
		projectId,
		documentId,
		slot,
		fileId,
	] as const;
}

/**
 * The family an uploaded font registers under: the theme's own name for the
 * file, never the admin's family, so an upload cannot shadow a font outside
 * the theme.
 */
function themeFontAlias(fileId: string): string {
	return `pa-font-${fileId.replace(/[^A-Za-z0-9-]/g, "-")}`;
}

/** Without the CSS Font Loading API the theme keeps its fallback family. */
function canRegisterFonts(): boolean {
	return (
		typeof FontFace === "function" &&
		typeof document !== "undefined" &&
		typeof document.fonts?.add === "function"
	);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes.buffer;
}

/**
 * One slot's uploaded Brand kit font (Fizzy #2946), read once by its file id
 * and registered on `document.fonts` under {@link themeFontAlias} until the
 * id changes or the page goes. The alias once the face has loaded, otherwise
 * null: before then, or after any refusal or a file that does not load, the
 * theme keeps its fallback family.
 */
function useThemeFontFace({
	projectId,
	documentId,
	slot,
	fileId,
}: {
	projectId: string;
	documentId: string;
	slot: ThemeFontSlot;
	fileId: string | null;
}): string | null {
	const query = useQuery({
		queryKey: proposalThemeFontQueryKey(
			projectId,
			documentId,
			slot,
			fileId,
		),
		queryFn:
			fileId && canRegisterFonts()
				? async () => {
						const font =
							await orpcClient.projects.proposalArtifact.getThemeFont(
								{ projectId, documentId, slot, fileId },
							);
						return base64ToArrayBuffer(font.base64);
					}
				: skipToken,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: THEME_FONT_GC_MS,
		// Every refusal is the same NOT_FOUND, and the fallback reads fine.
		retry: false,
	});
	const bytes = query.data;
	const alias = fileId ? themeFontAlias(fileId) : null;
	const [loadedAlias, setLoadedAlias] = useState<string | null>(null);

	useEffect(() => {
		if (!alias || !bytes || !canRegisterFonts()) {
			return;
		}
		const fontSet = document.fonts;
		const face = new FontFace(alias, bytes);
		// Cleared when the id changes or the page goes: a face that loads
		// after that is never added, and its alias never named.
		let current = true;
		face.load().then(
			() => {
				if (current) {
					fontSet.add(face);
					setLoadedAlias(alias);
				}
			},
			() => {
				// Not a font the browser can read: the fallback stays.
			},
		);
		return () => {
			current = false;
			fontSet.delete(face);
			setLoadedAlias(null);
		};
	}, [alias, bytes]);

	// Between a new id's render and the old face's removal, the old alias
	// must not be named.
	return alias && loadedAlias === alias ? alias : null;
}

/**
 * The root with each loaded upload's alias ahead of the admin's family, so
 * the file wins and the family and the stylesheet's fallback follow. The
 * same object when nothing has loaded.
 */
function withLoadedFonts(
	rootProps: ProposalThemeRootProps,
	loaded: ReadonlyArray<{
		slot: ThemeFontSlot;
		alias: string | null;
		family: string | undefined;
	}>,
): ProposalThemeRootProps {
	const style: Record<string, unknown> = { ...rootProps.style };
	let changed = false;
	for (const { slot, alias, family } of loaded) {
		if (alias) {
			style[THEME_FONT_PROPERTIES[slot]] =
				`"${alias}", "${safeFontFamily(family) ?? NEUTRAL_THEME.fonts[slot]}"`;
			changed = true;
		}
	}
	return changed
		? { ...rootProps, style: style as CSSProperties }
		: rootProps;
}

function rootPropsFor(paint: ProposalThemePaint): ProposalThemeRootProps {
	return {
		className: `${PROPOSAL_THEME_CLASSES.root} ${PROPOSAL_FONT_VARIABLES}`,
		[PROPOSAL_THEME_ATTRIBUTE]: "live",
		style: themeCustomProperties(paint) as CSSProperties,
	};
}

/**
 * The neutral professional style, worn while the server's answer is on its
 * way so a Proposal's page does not flash unthemed first.
 */
const NEUTRAL_PAINT = resolveThemePaint(
	buildProposalThemeTokens({
		organization: null,
		style: null,
		brandKit: null,
		recipient: null,
	}),
);
const NEUTRAL_ROOT_PROPS = rootPropsFor(NEUTRAL_PAINT);

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
 *
 * An uploaded Brand kit font is fetched and registered once the server's
 * paint is worn, and named on the root only after its face has loaded.
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
	const resolvedPaint = tokens ? resolveThemePaint(tokens) : undefined;
	// Keyed on what the root paints, not on the tokens object: every refetch
	// signs fresh logo URLs, which must not re-render the editor beneath.
	const paintKey = resolvedPaint ? JSON.stringify(resolvedPaint) : null;
	// Recomputed only when the paint's value changes, so its identity is stable.
	const serverPaint = useMemo(() => resolvedPaint, [paintKey]);
	const serverRootProps = useMemo(
		() => (serverPaint ? rootPropsFor(serverPaint) : undefined),
		[serverPaint],
	);
	const denied = query.isError && isThemeDenied(query.error);
	// Read from the tokens, not the paint key: a new upload for the same
	// family changes the file id and nothing the root paints.
	const fontFiles =
		enabled && serverRootProps && !denied
			? tokens?.proposer.fontFiles
			: undefined;
	const displayAlias = useThemeFontFace({
		projectId,
		documentId,
		slot: "display",
		fileId: fontFiles?.display.value ?? null,
	});
	const bodyAlias = useThemeFontFace({
		projectId,
		documentId,
		slot: "body",
		fileId: fontFiles?.body.value ?? null,
	});
	const paintFonts = serverPaint?.fonts;
	const displayFamily = paintFonts?.display;
	const bodyFamily = paintFonts?.body;
	const themedRootProps = useMemo(
		() =>
			serverRootProps &&
			withLoadedFonts(serverRootProps, [
				{ slot: "display", alias: displayAlias, family: displayFamily },
				{ slot: "body", alias: bodyAlias, family: bodyFamily },
			]),
		[serverRootProps, displayAlias, displayFamily, bodyAlias, bodyFamily],
	);

	// A disabled query also reports itself pending, so the hint comes first.
	if (!enabled) {
		return { active: false };
	}
	if (query.isError && (denied || !serverRootProps)) {
		return { active: false };
	}
	if (themedRootProps && serverPaint) {
		return { active: true, rootProps: themedRootProps, paint: serverPaint };
	}
	return {
		active: true,
		rootProps: NEUTRAL_ROOT_PROPS,
		paint: NEUTRAL_PAINT,
	};
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
