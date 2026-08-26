"use client";

import {
	detectPMTypeFromUrl,
	normalizePmWebUrl,
	pmDetectedTypeDisplayName,
} from "@repo/utils";
import { useSession } from "@saas/auth/hooks/use-session";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import { CloudIcon, CloudOffIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { orpcClient } from "../../../../../shared/lib/orpc-client";
import type { PmSyncStatus, UserStory } from "../../../lib/stories/types";
import { getPmToolBrandIcon } from "./pm-tool-brand-icon";

/**
 * Props for the shared PM-sync cloud toggle.
 *
 * The toggle is the single source of truth for the 3-state cloud icon and is
 * mounted on three surfaces (story workspace breadcrumb, story sheet header,
 * roadmap card). State is derived purely from props — the only internal
 * state is the in-flight mutation flag.
 */
export interface PmSyncCloudToggleProps {
	storyId: string;
	projectId: string;
	organizationId: string | null;
	/** Persisted server state — drives the three-state computation. */
	pmAutoSyncEnabled: boolean;
	externalId: string | null;
	externalUrl: string | null;
	/**
	 * True when the project has a configured PM-tool MCP integration. Pass
	 * `undefined` while the `pmCapabilities` query is in flight — the toggle
	 * renders an invisible same-size placeholder until the value resolves so
	 * the icon doesn't briefly flash Red on cold-cache loads.
	 */
	hasPmIntegration: boolean | undefined;
	/** PM tool display name (e.g. "Jira", "Azure DevOps") — used in tooltips. */
	pmToolName: string;
	lastPmSyncStatus: PmSyncStatus | null;
	/**
	 * Server-side error message for the most recent sync attempt. Surfaced
	 * verbatim in the toggle tooltip when `lastPmSyncStatus === "FAILED"` so
	 * the user can see what went wrong without leaving the page. Optional
	 * for backwards compatibility — call sites that don't pass it render
	 * a generic "Sync failed" message.
	 */
	lastPmSyncError?: string | null;
	lastSyncedAt: Date | string | null;
	/**
	 * Surface marker emitted on the `pm_sync_toggle_changed` telemetry event
	 * so log analysis can distinguish editor-driven toggles from sheet- and
	 * card-driven ones.
	 */
	source: "editor" | "sheet" | "card";
	/**
	 * When false, the toggle becomes display-only. The roadmap card sets this
	 * to false so a click opens the linked PM-tool URL instead of toggling
	 * (preserving the legacy card-icon interaction).
	 */
	interactive?: boolean;
	/** Visual scale: "sm" = 12px (roadmap card), "md" = 14px (editor + sheet). */
	size?: "sm" | "md";
	/**
	 * Render a short uppercase status label next to the icon
	 * ("Synced", "Syncing…", "Paused", "Not synced", "Conflict"). Editor +
	 * sheet surfaces opt in to make the toggle state self-documenting at
	 * a glance; the roadmap card stays icon-only because the row's other
	 * badges (PmSyncConflictBadge, PmSyncFailureBadge, PmSyncPendingIndicator)
	 * already carry status pills and adding a second label would clutter
	 * the card body.
	 */
	showLabel?: boolean;
	className?: string;
}

type DerivedState =
	| "synced"
	| "synced-with-conflict"
	| "synced-with-failure"
	| "off"
	| "not-configured";

/**
 * Neutral noun used in tooltips/aria-labels when the stored `externalUrl`
 * exists but its host doesn't match any known PM-tool pattern (self-hosted
 * Jira, GitHub Enterprise, custom trackers). Substituting the project-level
 * `pmToolName` here would re-introduce the AC3/AC4 mismatch bug #1303 was
 * filed for, so we deliberately use a generic phrase that interpolates
 * naturally into every translation key consuming `{pmToolName}`:
 *   - "Synced to the linked tool · …"
 *   - "Auto-sync paused · …each save will push to the linked tool."
 *   - "Auto-sync to the linked tool on. Click to disable." (aria)
 */
const UNKNOWN_PM_TOOL_LABEL = "the linked tool";

/**
 * Pure derivation from props. Mirrors spec §6.1 lines 563–569 verbatim. The
 * caller short-circuits on `hasPmIntegration === undefined` (loading) before
 * reaching this — by the time we get here the integration state is known.
 */
function deriveState(args: {
	hasPmIntegration: boolean;
	pmAutoSyncEnabled: boolean;
	lastPmSyncStatus: PmSyncStatus | null;
}): DerivedState {
	if (!args.hasPmIntegration) {
		return "not-configured";
	}
	if (args.pmAutoSyncEnabled && args.lastPmSyncStatus === "FAILED") {
		// FAILED takes precedence over CONFLICT — both are abnormal but FAILED
		// is non-recoverable until the user acts, while CONFLICT pauses sync
		// pending a merge choice. Surface the louder signal.
		return "synced-with-failure";
	}
	if (args.pmAutoSyncEnabled && args.lastPmSyncStatus === "CONFLICT") {
		return "synced-with-conflict";
	}
	if (args.pmAutoSyncEnabled) {
		return "synced";
	}
	return "off";
}

/**
 * Validate that a URL is a valid http/https external URL. Returns undefined
 * for any other scheme so we never render `javascript:` or relative paths
 * as a target href. Stored `externalUrl` values are sometimes the PM tool's
 * REST API endpoint rather than its web UI deep-link (Azure DevOps
 * `/_apis/wit/workItems/<id>`, GitHub `api.github.com/.../issues/<n>`,
 * Jira `/rest/api/3/issue/<key>`) — those render as raw JSON in a browser,
 * which is bug #1303. `normalizePmWebUrl` rewrites them to the human-readable
 * equivalent so a single click goes to the right place.
 */
function getValidExternalUrl(
	url: string | null | undefined,
): string | undefined {
	if (!url) {
		return undefined;
	}
	const trimmed = url.trim();
	if (/^https?:\/\//i.test(trimmed)) {
		return normalizePmWebUrl(trimmed);
	}
	return undefined;
}

/**
 * Apply a partial patch to a single story inside a cached `stories.list`
 * response. Defensive: returns `data` unchanged when the shape doesn't
 * match (e.g. cache cleared mid-mutation).
 */
function patchStoryInList(
	data: unknown,
	storyId: string,
	patch: Partial<UserStory>,
): unknown {
	if (
		!data ||
		typeof data !== "object" ||
		!("stories" in data) ||
		!Array.isArray((data as { stories: unknown }).stories)
	) {
		return data;
	}
	const typed = data as { stories: UserStory[] };
	return {
		...typed,
		stories: typed.stories.map((s) =>
			s.id === storyId ? { ...s, ...patch } : s,
		),
	};
}

/**
 * Format a `lastSyncedAt` Date or ISO string as a relative-time fragment
 * (e.g. "5 minutes"). Returns null when the input is missing or invalid
 * so the caller can decide whether to render the second tooltip line.
 */
function formatLastSynced(value: Date | string | null): string | null {
	if (!value) {
		return null;
	}
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return formatDistanceToNow(date);
}

export function PmSyncCloudToggle({
	storyId,
	projectId,
	organizationId,
	pmAutoSyncEnabled,
	externalId,
	externalUrl,
	hasPmIntegration,
	pmToolName,
	lastPmSyncStatus,
	lastPmSyncError = null,
	lastSyncedAt,
	source,
	interactive = true,
	size = "md",
	showLabel = false,
	className,
}: PmSyncCloudToggleProps) {
	const queryClient = useQueryClient();
	const router = useRouter();
	const { basePath } = useOrganizationContext();
	const { user } = useSession();
	const t = useTranslations("tooltips.stories.pmSync");

	// Live-region message for screen readers. Polite announcement on every
	// successful toggle, auto-cleared after ~2s so it doesn't pile up if the
	// user clicks repeatedly. The element itself is `sr-only` and never takes
	// visual space.
	const [announcement, setAnnouncement] = useState<string | null>(null);
	const announceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		return () => {
			if (announceTimerRef.current) {
				clearTimeout(announceTimerRef.current);
			}
		};
	}, []);

	// Note: the loading branch (hasPmIntegration === undefined) is handled
	// inside the JSX return below so all React hooks remain unconditional and
	// hook order is stable across renders (Rules of Hooks).
	const isLoading = hasPmIntegration === undefined;
	const state = deriveState({
		hasPmIntegration: hasPmIntegration ?? false,
		pmAutoSyncEnabled,
		lastPmSyncStatus,
	});
	// Auto-sync ON but no card yet ("Not synced"). In the labeled (editor/sheet)
	// pill we render this muted rather than emerald so the pill matches its
	// neutral "Not synced" label; the compact, label-less roadmap icon keeps the
	// existing emerald "auto-sync armed" cue (pillBgClass + this gate only apply
	// when `showLabel`).
	const armedUnlinked = state === "synced" && !externalId;

	// Cache keys — invalidate the same `stories.list` (and `stories.get` for
	// the editor) the surface depends on so a successful PATCH refreshes
	// every mounted view.
	const storiesListQueryKey = orpc.projects.stories.list.queryKey({
		input: { projectId, organizationId },
	});
	const storyGetQueryKey = orpc.projects.stories.get.queryKey({
		input: { projectId, storyId, organizationId },
	});

	// Optimistic toggle mutation — flips `pmAutoSyncEnabled` in the cached
	// list immediately, rolls back on error. The server PATCH carries only
	// the toggle field so it cannot collide with a concurrent in-flight Save
	// that is mutating title/description/etc..
	const togglePmAutoSync = useMutation({
		mutationFn: async (next: boolean) => {
			return await orpcClient.projects.stories.update({
				projectId,
				storyId,
				organizationId,
				pmAutoSyncEnabled: next,
			});
		},
		onMutate: async (next) => {
			await queryClient.cancelQueries({ queryKey: storiesListQueryKey });
			await queryClient.cancelQueries({ queryKey: storyGetQueryKey });

			const previousList = queryClient.getQueryData(storiesListQueryKey);
			const previousGet = queryClient.getQueryData(storyGetQueryKey);

			// Cast through `unknown` so the patch helpers can stay schema-agnostic
			// (there are several story-shape variants used by the various surfaces;
			// the helpers handle missing fields defensively).
			queryClient.setQueryData(
				storiesListQueryKey,
				(data) =>
					patchStoryInList(data, storyId, {
						pmAutoSyncEnabled: next,
					}) as typeof data,
			);
			queryClient.setQueryData(storyGetQueryKey, (data) => {
				if (
					!data ||
					typeof data !== "object" ||
					!("story" in data) ||
					!data.story
				) {
					return data;
				}
				return {
					...data,
					story: {
						...(data as { story: Record<string, unknown> }).story,
						pmAutoSyncEnabled: next,
					},
				} as typeof data;
			});

			return { previousList, previousGet };
		},
		onSuccess: (_data, next) => {
			// Structured-log telemetry. Mirrors the `[ai_title_edited]` pattern
			// at `StoryWorkspace.tsx:1571` — single line, event-name prefix,
			// payload object. Downstream log shippers pick events up by name.
			console.log("[pm_sync_toggle_changed]", {
				storyId,
				projectId,
				organizationId,
				enabled: next,
				prior: !next,
				userId: user?.id ?? null,
				source,
			});
			// Initial-push feedback. When the user flips the toggle ON for an
			// unlinked feature, the server gate (update-story.ts) fires
			// `enqueuePmSync` with `forceInitialPush: true` — the work item
			// gets created in the PM tool and linked back asynchronously. The
			// click itself is the action; the Save button is just Save. Surface
			// a toast so the user knows the push is in flight rather than
			// staring at the tooltip wondering whether the click did anything.
			if (next && !externalId && hasPmIntegration) {
				// First-push toast: the URL doesn't exist yet, so the
				// project-level `pmToolName` is the only available name.
				toast.success(`Syncing feature to ${pmToolName}…`, {
					description: "Each save will push automatically.",
				});
			}
			// Polite screen-reader announcement so keyboard/AT users get
			// confirmation. The element below is `sr-only` and clears itself
			// after ~2s so repeated toggles don't queue up.
			setAnnouncement(next ? "Auto-sync enabled" : "Auto-sync disabled");
			if (announceTimerRef.current) {
				clearTimeout(announceTimerRef.current);
			}
			announceTimerRef.current = setTimeout(
				() => setAnnouncement(null),
				2000,
			);
		},
		onError: (error, next, ctx) => {
			if (ctx?.previousList !== undefined) {
				queryClient.setQueryData(storiesListQueryKey, ctx.previousList);
			}
			if (ctx?.previousGet !== undefined) {
				queryClient.setQueryData(storyGetQueryKey, ctx.previousGet);
			}
			toast.error("Could not update auto-sync", {
				description: error instanceof Error ? error.message : undefined,
				action: {
					label: "Retry",
					onClick: () => togglePmAutoSync.mutate(next),
				},
			});
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
			queryClient.invalidateQueries({ queryKey: storyGetQueryKey });
		},
	});

	const isPending = togglePmAutoSync.isPending;
	const validExternalUrl = getValidExternalUrl(externalUrl);
	const lastSyncedRelative = formatLastSynced(lastSyncedAt);

	// Open an external ticket URL in a fresh browser tab.
	//
	// Background: declarative `<a target="_blank">`, programmatic anchor
	// clicks, and `window.open(url, '_blank', 'noopener,noreferrer')` are all
	// captured by Chrome into the destination PWA's standalone window when
	// the destination origin (e.g., Fizzy.io) has `capture_links` enabled in
	// its installed PWA manifest. Users with the Fizzy PWA installed end up
	// in the standalone Fizzy app instead of a browser tab, which obscures
	// the URL and breaks "Open in new tab" expectations on the roadmap.
	//
	// The only reliable source-side bypass is to open `about:blank` first
	// (a same-origin `about:` window that is not in any PWA scope) and then
	// assign `w.location.href` to navigate the new tab to the target URL.
	// `w.opener = null` severs the backref so the opened tab cannot
	// manipulate this one via `window.opener`, preserving the security
	// guarantee normally provided by `rel="noopener"`. The previous
	// "blank page" regression (#1435) happened when the popup was blocked
	// mid-assignment — we guard against it by early-returning when the
	// initial `window.open("about:blank")` returns `null`.
	const openExternalTicketUrl = (url: string) => {
		const w = window.open("about:blank", "_blank");
		if (!w) {
			return;
		}
		w.opener = null;
		w.location.href = url;
	};

	// Per-item PM tool type derived from the stored externalUrl: drives both
	// the tooltip name (bug #1303, AC3/AC4) and the brand glyph (bug #1301).
	// When a project has switched integrations (e.g. ADO → Jira) the
	// project-level `pmToolName` reflects the NEW tool, but historical
	// rows still link to the OLD one — resolving identity from the URL
	// host keeps label and icon honest with the actual click target.
	const brandedToolType = validExternalUrl
		? detectPMTypeFromUrl(validExternalUrl)
		: undefined;

	// Tooltip-name fallback policy (kept narrow so AC3/AC4 hold):
	//   - URL missing             → use the project-level `pmToolName` prop
	//                               (no stored link → no stale-link risk).
	//   - URL present, host known → display name from the URL's host.
	//   - URL present, host       → neutral literal — using the project prop
	//     unknown                   here would re-introduce the exact
	//                               tooltip/destination mismatch this bug
	//     is about (self-hosted Jira / GitHub Enterprise / custom tracker
	//     hosts all fall into this bucket). The label deliberately uses no
	//     proper noun so we never claim a specific tool we can't verify.
	const effectivePmToolName = validExternalUrl
		? (pmDetectedTypeDisplayName(brandedToolType) ?? UNKNOWN_PM_TOOL_LABEL)
		: pmToolName;

	// Brand-icon swap (bug #1301): synced states show the per-tool glyph
	// when the host is known so the user can tell at a glance which PM
	// tool is linked. Off and not-configured keep the universal cloud-off
	// glyphs — state semantics outweigh brand there.
	const BrandIcon =
		state === "synced" ||
		state === "synced-with-conflict" ||
		state === "synced-with-failure"
			? getPmToolBrandIcon(brandedToolType)
			: undefined;

	// Roadmap deep-link with the story focused. Used by the conflict-overlay
	// click handler so the user lands on the surface where the conflict diff
	// modal can be opened.
	const roadmapUrl = `${basePath}/projects/${projectId}?tab=stories&storyId=${encodeURIComponent(
		storyId,
	)}`;
	const settingsIntegrationsUrl = `${basePath}/settings/integrations`;

	// Visual sizing per spec §6.7. The card surface uses size-3 (~12px); the
	// editor + sheet use size-3.5 (~14px).
	const iconSizeClass = size === "sm" ? "size-3" : "size-3.5";

	// Whether this state should respond to a primary click as a toggle. The
	// roadmap card surface is display-only (interactive=false) and the
	// not-configured state is non-interactive on every surface.
	const canToggle =
		interactive &&
		(state === "synced" ||
			state === "off" ||
			state === "synced-with-failure");

	const handleToggleClick = (event: React.MouseEvent) => {
		event.stopPropagation();
		if (isPending) {
			return;
		}
		if (canToggle) {
			togglePmAutoSync.mutate(!pmAutoSyncEnabled);
			return;
		}
		// Conflict variant on an interactive surface: navigate to roadmap
		// with the story focused instead of PATCHing. Display-only
		// surfaces don't reach this handler because they render an <a>.
		if (state === "synced-with-conflict") {
			router.push(roadmapUrl);
		}
	};

	// Per spec §6.8 the Conflict overlay appends a suffix to whichever base
	// label is active, so screen-readers announce both the toggle state and
	// the conflict cue together. The "off" variant is split by whether a
	// ticket exists — same distinction the tooltip copy makes — so screen
	// reader users hear "click to create a ticket" vs "click to resume".
	const baseAriaLabel = (() => {
		switch (state) {
			case "synced":
			case "synced-with-conflict":
			case "synced-with-failure":
				return externalId
					? `Auto-sync to ${effectivePmToolName} on. Click to disable.`
					: `Auto-sync on — not synced yet; will push to ${effectivePmToolName} on the next save. Click to disable.`;
			case "off":
				return externalId
					? `Auto-sync paused. Click to resume — each save will push to ${effectivePmToolName}.`
					: `Click to create a ticket in ${effectivePmToolName} now.`;
			case "not-configured":
				return "No PM tool configured.";
		}
	})();

	const ariaLabel = (() => {
		if (state === "synced-with-conflict") {
			return `${baseAriaLabel} · Conflict — open in roadmap to resolve.`;
		}
		if (state === "synced-with-failure") {
			// Surface the server-side error verbatim to screen-reader users so
			// they hear the actionable detail (e.g. "PM tool was configured by
			// another user", "GitLab is not connected for this project") rather
			// than just a generic "sync failed" announcement.
			const errorFragment = lastPmSyncError ? `: ${lastPmSyncError}` : "";
			return `${baseAriaLabel} · Sync failed${errorFragment}`;
		}
		return baseAriaLabel;
	})();

	// Shared "Open ticket" affordance rendered as its own tooltip line
	// across the synced / off / synced-with-conflict states whenever the
	// row has a valid external URL. Per user feedback: once a ticket exists,
	// the link should be reachable regardless of whether auto-sync is on
	// or off — pausing sync shouldn't bury the way to view the ticket.
	const openTicketLink =
		externalId && validExternalUrl ? (
			<span>
				<a
					href={validExternalUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="underline underline-offset-2 hover:text-background"
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						openExternalTicketUrl(validExternalUrl);
					}}
				>
					{t("openTicket")}
				</a>
			</span>
		) : null;

	// Tooltip body content per state. Kept inline so the JSX below stays
	// flat — splitting these into separate components would obscure the
	// fact that all four states share the same outer `<Tooltip>` shell.
	const tooltipBody = (() => {
		switch (state) {
			case "synced": {
				// Plain-text primary line — "Open ticket" is the shared
				// affordance on the line below.
				const primary = externalId
					? t("syncedLinked", { pmToolName: effectivePmToolName })
					: t("syncedArmed", { pmToolName: effectivePmToolName });
				return (
					<div className="flex flex-col gap-1">
						<span>{primary}</span>
						{openTicketLink}
						{lastSyncedRelative ? (
							<span className="text-background/70">
								{t("lastSyncedAt", {
									time: lastSyncedRelative,
								})}
							</span>
						) : null}
					</div>
				);
			}
			case "off": {
				// Split the off tooltip by whether a ticket already exists.
				// Unlinked: the click will CREATE a ticket right now — make
				// that crystal clear. Linked-but-paused: the click just
				// resumes auto-sync; the existing ticket stays where it is.
				const primary = externalId
					? t("offLinked", { pmToolName: effectivePmToolName })
					: t("offUnlinked", { pmToolName: effectivePmToolName });
				return (
					<div className="flex flex-col gap-1">
						<span>{primary}</span>
						{openTicketLink}
					</div>
				);
			}
			case "not-configured":
				return (
					<span>
						{t.rich("notConfigured", {
							link: (chunks) => (
								<Link
									href={settingsIntegrationsUrl}
									className="underline underline-offset-2 hover:text-background"
									onClick={() => {
										// Fire-and-forget telemetry: the link still
										// navigates, so do not preventDefault. Mirrors
										// the `[ai_title_edited]` structured-log
										// convention.
										console.log(
											"[pm_sync_red_state_clicked]",
											{
												storyId,
												projectId,
												organizationId,
												userId: user?.id ?? null,
											},
										);
									}}
								>
									{chunks}
								</Link>
							),
						})}
					</span>
				);
			case "synced-with-conflict":
				return (
					<div className="flex flex-col gap-1">
						<span>
							{t.rich("conflict", {
								link: (chunks) => (
									<Link
										href={roadmapUrl}
										className="underline underline-offset-2 hover:text-background"
										onClick={(e) => e.stopPropagation()}
									>
										{chunks}
									</Link>
								),
							})}
						</span>
						{openTicketLink}
					</div>
				);
			case "synced-with-failure":
				return (
					<div className="flex flex-col gap-1">
						<span>
							{t("failed", {
								error: lastPmSyncError ?? "Unknown error",
							})}
						</span>
						<span className="text-background/70">
							{t("failedActionHint")}
						</span>
						{openTicketLink}
					</div>
				);
		}
	})();

	// Short status label rendered next to the icon when `showLabel` is on
	// (editor + sheet surfaces). Mirrors the doc editor's Yjs sync pill copy
	// (`CollaborationStatus.tsx` — "Synced" / "Syncing…" / "Offline") so the
	// two surfaces speak the same language. The not-configured state returns
	// null because the destructive-red icon is loud enough on its own — a
	// pill would be redundant.
	const statusLabel: string | null = (() => {
		switch (state) {
			case "synced":
				// Armed but never linked is "Not synced" (it will push on the next
				// save) — NOT "Syncing…", which read as a stuck spinner that never
				// cleared since no sync is actually in flight.
				return externalId ? "Synced" : "Not synced";
			case "off":
				return externalId ? "Paused" : "Not synced";
			case "synced-with-conflict":
				return "Conflict";
			case "synced-with-failure":
				return "Failed";
			case "not-configured":
				return null;
		}
	})();

	// Icon color classes — token-based so light/dark themes both render
	// visibly without hardcoded hex values. Replaces the previous
	// `text-muted-foreground/40-45` muted fades; the emerald `--secondary`
	// token explicitly signals "active/syncing" the same way it does for
	// AI-active states across the app.
	const iconColorClass = (() => {
		switch (state) {
			case "synced":
				// Muted for the labeled "Not synced" (armed + unlinked) pill so
				// icon + label agree; emerald otherwise. The roadmap icon (no
				// label) always stays emerald.
				return armedUnlinked && showLabel
					? "text-muted-foreground/65 hover:text-muted-foreground"
					: "text-secondary hover:text-secondary/80";
			case "synced-with-conflict":
				// Emerald — visible against both warm-stone light bg and dark
				// zinc bg. Slightly deeper on hover so the affordance reads
				// clearly without changing dimension.
				return "text-secondary hover:text-secondary/80";
			case "synced-with-failure":
				// Destructive — the row is auto-sync-on but the last attempt
				// failed; the user must act to recover. Matches the Red used
				// for the not-configured state and the roadmap card's
				// PmSyncFailureBadge so failure semantics read consistently
				// across surfaces.
				return "text-destructive hover:text-destructive/80";
			case "off":
				// Muted but visibly more present than the previous /45 fade.
				return "text-muted-foreground/65 hover:text-muted-foreground";
			case "not-configured":
				return "text-destructive";
		}
	})();

	// Pill background classes for the `showLabel` variant. Borrowed from
	// the Badge component's secondary / outline / warning variants so the
	// editor breadcrumb stays visually consistent with badges used
	// elsewhere on the same row (PmSyncConflictBadge, PmSyncFailureBadge,
	// PmSyncPendingIndicator on the roadmap card).
	const pillBgClass = (() => {
		switch (state) {
			case "synced":
				// Muted outline for "Not synced" (armed + unlinked); emerald tint
				// for a real synced item.
				return armedUnlinked
					? "border border-border/50 hover:bg-accent hover:border-accent-foreground/20"
					: "bg-secondary/10 hover:bg-secondary/20 dark:bg-secondary/20 dark:hover:bg-secondary/30";
			case "off":
				return "border border-border/50 hover:bg-accent hover:border-accent-foreground/20";
			case "synced-with-conflict":
				return "bg-secondary/10 hover:bg-secondary/20 dark:bg-secondary/20 dark:hover:bg-secondary/30 ring-1 ring-highlight";
			case "synced-with-failure":
				return "bg-destructive/10 hover:bg-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 ring-1 ring-destructive";
			case "not-configured":
				return "bg-destructive/10 hover:bg-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30";
		}
	})();

	// Shared trigger layout classes. When `showLabel` is true the trigger
	// renders as a compact pill (icon + uppercase 11px label, similar
	// rhythm to the doc editor's CollaborationStatus pill at h-4 text-[10px]
	// but a touch larger since this row carries fewer adjacent elements);
	// when false it stays a standalone icon button, matching the legacy
	// card-surface footprint.
	const labeledLayoutClass = showLabel
		? "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium tracking-wider uppercase transition-colors duration-150"
		: "inline-flex items-center justify-center rounded-full p-0.5 transition-colors";

	// Render the trigger inside a single shared <Tooltip>. The trigger
	// element type varies by state: <button> for the interactive toggle
	// states, <a> for the display-only linked-Synced sub-state on the
	// roadmap card, and <span aria-disabled> for not-configured.
	const renderTrigger = () => {
		// Display-only surface (roadmap card) with a valid external URL
		// preserves the legacy "click to open ticket" behavior — only
		// applies when the toggle is on AND there is a real linked
		// ticket. The conflict overlay variant on a display-only surface
		// is handled separately below so it links to the roadmap, not
		// the external ticket.
		if (
			!interactive &&
			state === "synced" &&
			externalId &&
			validExternalUrl
		) {
			return (
				<a
					href={validExternalUrl}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={ariaLabel}
					data-state={state}
					data-pm-tool-type={brandedToolType ?? undefined}
					className={cn(
						"inline-flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
						iconColorClass,
						className,
					)}
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						openExternalTicketUrl(validExternalUrl);
					}}
				>
					{BrandIcon ? (
						<BrandIcon className={iconSizeClass} />
					) : (
						<CloudIcon
							className={iconSizeClass}
							aria-hidden="true"
						/>
					)}
				</a>
			);
		}

		if (state === "not-configured") {
			// Two-surface affordance. The editor/sheet keeps the span +
			// tooltip-link pattern (the user is deep in a feature edit;
			// they should explicitly acknowledge the missing integration
			// via the tooltip context). The roadmap card promotes the icon
			// itself to a real anchor so a single tap on touch devices —
			// where hover doesn't exist — routes the user to Settings.
			if (!interactive) {
				return (
					<a
						href={settingsIntegrationsUrl}
						aria-label={ariaLabel}
						data-state={state}
						className={cn(
							"inline-flex items-center justify-center text-destructive hover:text-destructive/80 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
							className,
						)}
						onClick={(e) => {
							e.stopPropagation();
							console.log("[pm_sync_red_state_clicked]", {
								storyId,
								projectId,
								organizationId,
								userId: user?.id ?? null,
							});
						}}
					>
						<CloudOffIcon
							className={iconSizeClass}
							aria-hidden="true"
						/>
					</a>
				);
			}
			// Editor/sheet: non-interactive icon, tooltip carries the link.
			// The span MUST receive pointer + focus events so Radix Tooltip
			// can open on hover and on keyboard focus; `cursor-default`
			// keeps the icon from looking like a click target.
			return (
				<span
					role="img"
					aria-disabled="true"
					aria-label={ariaLabel}
					data-state={state}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the span is intentionally non-interactive, but Radix Tooltip needs a focusable trigger so keyboard users can open the tooltip on focus — the actionable element lives inside the tooltip body (a real <Link> to Settings > Integrations).
					tabIndex={0}
					className={cn(
						"inline-flex items-center justify-center text-destructive cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
						className,
					)}
				>
					<CloudOffIcon
						className={iconSizeClass}
						aria-hidden="true"
					/>
				</span>
			);
		}

		// Conflict variant on a display-only surface: render as an <a> to
		// the roadmap so keyboard users can navigate; on an interactive
		// surface it stays a <button> handled by handleToggleClick.
		if (state === "synced-with-conflict" && !interactive) {
			return (
				<a
					href={roadmapUrl}
					aria-label={ariaLabel}
					data-state={state}
					data-pm-tool-type={brandedToolType ?? undefined}
					className={cn(
						"inline-flex items-center justify-center rounded-full p-0.5 ring-1 ring-highlight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
						iconColorClass,
						className,
					)}
					onClick={(e) => e.stopPropagation()}
				>
					{BrandIcon ? (
						<BrandIcon className={iconSizeClass} />
					) : (
						<CloudIcon
							className={iconSizeClass}
							aria-hidden="true"
						/>
					)}
				</a>
			);
		}

		// Common icon — used by both the display-only and interactive
		// branches below. Off keeps the universal cloud-off glyph (state
		// semantics outweigh brand). Synced states prefer the brand
		// logo when the URL host identifies a known tool, falling back
		// to the generic cloud glyph for unlinked / unknown rows so the
		// previous "syncing" iconography is preserved.
		const iconNode =
			state === "off" ? (
				<CloudOffIcon className={iconSizeClass} aria-hidden="true" />
			) : BrandIcon ? (
				<BrandIcon className={iconSizeClass} />
			) : (
				<CloudIcon className={iconSizeClass} aria-hidden="true" />
			);

		// Display-only branch: card surface for Synced (armed, no
		// externalUrl) and Off. A click does not look interactive — the
		// tooltip still opens on focus via the surrounding TooltipTrigger.
		// (The card's Synced-with-conflict and linked-Synced cases are
		// handled above with their own <a> elements.)
		if (!interactive) {
			return (
				<span
					role="img"
					aria-label={ariaLabel}
					data-state={state}
					data-pm-tool-type={brandedToolType ?? undefined}
					className={cn(
						"inline-flex items-center justify-center rounded-full p-0.5",
						iconColorClass,
						className,
					)}
				>
					{iconNode}
				</span>
			);
		}

		// Interactive branch: editor + sheet surfaces. Synced (with or
		// without the conflict-ring overlay) and Off both render as
		// <button>. The conflict ring is a wrapping `ring-1 ring-highlight`
		// overlay — amber per design-system convention for "warning /
		// needs attention" (and to keep it visually distinct from the
		// destructive-red Red/Not-configured state). The pill background
		// already carries the conflict ring in `pillBgClass` when
		// `showLabel`; the bare-icon branch wraps with `ring-1` manually.

		return (
			<button
				type="button"
				aria-label={ariaLabel}
				aria-pressed={pmAutoSyncEnabled}
				aria-disabled={isPending || undefined}
				disabled={isPending}
				data-state={state}
				data-pm-tool-type={brandedToolType ?? undefined}
				className={cn(
					labeledLayoutClass,
					iconColorClass,
					showLabel && pillBgClass,
					// Bare-icon variant still needs the conflict ring; the
					// pill variant's pillBgClass already includes it for
					// the synced-with-conflict state.
					!showLabel &&
						state === "synced-with-conflict" &&
						"ring-1 ring-highlight",
					// Same idea for the failure ring — destructive-red so the
					// icon reads "needs attention" without relying on color
					// alone (the ring + icon-color combo carries the signal).
					!showLabel &&
						state === "synced-with-failure" &&
						"ring-1 ring-destructive",
					"cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
					isPending && "cursor-default opacity-70",
					className,
				)}
				onClick={handleToggleClick}
			>
				{iconNode}
				{showLabel && statusLabel ? <span>{statusLabel}</span> : null}
			</button>
		);
	};

	// Loading branch: render an invisible same-size placeholder so the icon
	// doesn't briefly flash Red on a cold-cache load and so the surrounding
	// flex row doesn't reflow when the real toggle finally renders. Handled
	// here (inside the return) rather than as an early return so all React
	// hooks above remain unconditional (Rules of Hooks).
	if (isLoading) {
		const iconSizeClass = size === "sm" ? "size-3" : "size-3.5";
		return (
			<span
				aria-hidden="true"
				data-state="loading"
				className={cn(
					"inline-flex items-center justify-center rounded-full p-0.5 invisible",
					className,
				)}
			>
				<CloudIcon className={iconSizeClass} />
			</span>
		);
	}

	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>{renderTrigger()}</TooltipTrigger>
				<TooltipContent>{tooltipBody}</TooltipContent>
			</Tooltip>
			{/* Screen-reader-only live region so AT users hear "Auto-sync
			    enabled / disabled" on a successful toggle. Cleared after ~2s
			    via the mutation's onSuccess timer so repeated toggles don't
			    queue. `<output>` is the semantic element for an ARIA-status
			    live region (per WAI-ARIA), so prefer it over `<span role="status">`. */}
			<output className="sr-only" aria-live="polite">
				{announcement ?? ""}
			</output>
		</>
	);
}
