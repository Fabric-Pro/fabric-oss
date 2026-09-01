/**
 * Registry of UI-editable feature flags, and the pure resolution rule.
 *
 * Deliberately curated rather than derived from the FABRIC_FEATURE_* env-var
 * names: the flags are not uniform (opt-in default-OFF vs kill-switch
 * default-ON, and several gate Temporal crons where a runtime flip has
 * workflow-replay implications). Registering a flag here is the deliberate act
 * of declaring it safe to toggle at runtime.
 *
 * This module is pure — no database, no caching, no I/O. That keeps the
 * precedence rule trivially testable and lets `@repo/database` layer the
 * storage on top without a circular dependency.
 */
import { parseOptInFlag } from "./feature-flag";

export interface FeatureFlagDefinition {
	/** Short human label for the admin UI. */
	label: string;
	/** One sentence on what turning this on does. */
	description: string;
	/** The env var that seeds this flag when no override row exists. */
	envVar: string;
	/** Value when neither an override nor the env var is set. */
	default: boolean;
	/** Optional risk note surfaced in the admin UI. */
	note?: string;
}

export const FEATURE_FLAG_REGISTRY = {
	OPENAPI_SPEC_CONTEXT: {
		label: "OpenAPI/Swagger specs as project context",
		description:
			"Indexes an uploaded API spec by endpoint and model, so the assistant knows the API's contract when planning an integration against it.",
		envVar: "FABRIC_FEATURE_OPENAPI_SPEC_CONTEXT",
		default: false,
		note: "Fizzy #2236. Off = a .json/.yaml spec is chunked by character window exactly as before, so rollback is a flag flip with no redeploy and no migration. Already-ingested specs keep the chunks they have until re-embedded, so flipping this on for an existing project needs a re-embed to take effect.",
	},
	PROJECT_READINESS: {
		label: "Project readiness checklist",
		description:
			"Shows a phase-aware readiness panel on every project page, listing the setup items a project still needs before Fabric can work well on it.",
		envVar: "FABRIC_FEATURE_PROJECT_READINESS",
		default: false,
		note: "Fizzy #2165. Off means neither the indicator nor the panel renders and no readiness is computed; the stored manual states (snoozed / not applicable / help requested) are left untouched, so flipping it back on restores them exactly. Readiness itself never blocks anything. The one action this flag does gate is adding a link context source: on, the Add Context dialog requires the source to be classified, because the Knowledge Base item reads that classification and nothing could satisfy it otherwise. Off, the link flow is exactly as it was.",
	},
	PERSONAL_MEETINGS: {
		label: "Personal meetings in Meeting Digest",
		description:
			"Adds the All Meetings filter. Personal transcripts are never stored.",
		envVar: "FABRIC_FEATURE_PERSONAL_MEETINGS",
		default: false,
		note: "Privacy-sensitive (#1899). Personal calendar data is fetched per-view and never persisted.",
	},
	PERSONAL_INSIGHTS_CACHE: {
		label: "Remember personal meeting summaries on this device",
		description:
			"Lets a user opt in to caching their own personal meeting summaries in browser storage, so re-opening one is instant and costs no tokens.",
		envVar: "FABRIC_FEATURE_PERSONAL_INSIGHTS_CACHE",
		default: false,
		note: "Privacy-sensitive (#2104). Browser-local only — nothing is stored server-side, so the #1899 no-persistence guarantee is unaffected. Separate from PERSONAL_MEETINGS so the cache can be rolled back without disabling personal meetings.",
	},
	MEETING_CONTEXT_IMPORT: {
		label: "Import a personal meeting into project context",
		description:
			"Lets a user deliberately add one of their own meeting transcripts to a project, where it becomes ordinary project context.",
		envVar: "FABRIC_FEATURE_MEETING_CONTEXT_IMPORT",
		default: false,
		note: "Privacy-sensitive (#2170). This is the ONLY path that stores personal meeting content server-side, and it does so only on an explicit, confirmed user action — everything else in the personal lane stays never-persisted (#1899). Separate from PERSONAL_MEETINGS so it can be withdrawn without taking the read-only personal lane down with it. Turning it off blocks new imports; contexts already imported remain, and are deleted from the project's Context tab like any other source.",
	},
	MEETING_AGENDA: {
		label: "Pre-meeting agenda generation",
		description:
			"Shows upcoming meetings in the Meeting Digest and lets project admins generate an AI agenda for them.",
		envVar: "FABRIC_FEATURE_MEETING_AGENDA",
		default: false,
		note: "Gates both the upcoming-meetings list (#1901a) and agenda generation (#1901). An upcoming list with no agenda button is a half-feature, so they share one flag.",
	},
	MEETING_ACTION_ITEM_LINKING: {
		label: "Link meeting action items to work items",
		description:
			"Matches action items in a meeting digest to related features and bugs, and shows the links on both sides.",
		envVar: "FABRIC_FEATURE_MEETING_ACTION_ITEM_LINKING",
		default: false,
		note: "Spends embedding + LLM tokens the first time each meeting is opened (#1902). Off means no matching runs and nothing renders; links already stored are left untouched, so re-enabling restores them.",
	},
	PROJECT_SHORTCUTS: {
		label: "Quick-access project shortcuts in navigation",
		description:
			"Shows up to three project shortcuts under the Projects nav item — favorites first, remaining slots filled by most recently visited.",
		envVar: "FABRIC_FEATURE_PROJECT_SHORTCUTS",
		default: false,
		note: "Nav-level change (#1694). Visit timestamps are recorded whether or not this is on, so flipping it reveals a populated list rather than an empty one. A visit timestamp is one overwritten marker per user-project pair, not a history of opens; it is retained for as long as both the user and the project exist and is removed when either is deleted. Turning this off leaves the stored columns untouched and re-enabling restores the feature intact.",
	},
	PROJECT_FAVORITES: {
		label: "Favorite a project",
		description:
			"Adds the star control on the projects list and the project header, letting a user pin projects to the top of their shortcuts.",
		envVar: "FABRIC_FEATURE_PROJECT_FAVORITES",
		default: false,
		note: "Separate from PROJECT_SHORTCUTS (#1694) so the favorite write surface can be rolled back without disabling the shortcuts, which work from recency alone. Off hides the control everywhere; favorites already stored are left untouched and still order the shortcuts.",
	},
	UNIFIED_AGENT_INTERFACE: {
		label: "Unified agent interface",
		description:
			"Serves the consolidated agent chat — one surface reachable as a floating drawer or a full page, with a simple and an advanced mode — in place of the separate Nexus and Loom pages.",
		envVar: "FABRIC_FEATURE_UNIFIED_AGENT_INTERFACE",
		default: true,
		note: "Default-ON and deliberately temporary (#2040). It is a rollback lever, not a phased rollout: nobody is staged onto the old path and there is no cohort logic, so the flag exists purely so a regression is one setting away from reverted rather than a revert of a very large change. Off restores the previous surfaces; conversations are written to the same tables either way, so flipping it in either direction never strands a thread. Remove it, and the superseded surfaces, once the unified interface has been stable in production for a release or two — while it lives, both code paths must be kept working, which is exactly the duplication this consolidation exists to end.",
	},
	NEWSLETTER_APPROVAL_CHAT: {
		label: "Release-notes review alerts in chat",
		description:
			'Posts the "release notes await review" alert to each project\'s configured Teams and Slack channels, beside the in-app bell and the reviewer email.',
		envVar: "FABRIC_FEATURE_NEWSLETTER_APPROVAL_CHAT",
		default: true,
		note: "Fizzy #2203. Nothing is posted for a project that has selected no channels — the per-project channel picker in Newsletter settings is the real opt-in, and this flag only decides whether that picker is honoured. Two consequences follow from the default being ON. From the first APPROVAL row an environment writes, rolling that environment's worker back to a build predating the delivery kind is unsafe: those older ledger queries key without it and will clobber or miscount the row, and no schema change undoes that — forward-fix only. And because the default is ON rather than OFF, an override table that cannot be read resolves this flag back ON rather than off, so turning it off here is not durable against a fault in the override table itself. Read only in a Temporal activity, never in workflow code (determinism).",
	},
	ROLE_TAG_ENFORCEMENT: {
		label: "Require a role/function tag",
		description:
			"Blocks the app with a modal until a user has set at least one default role/function tag, and asks members to confirm their role the first time they open a project.",
		envVar: "FABRIC_FEATURE_ROLE_TAG_ENFORCEMENT",
		default: false,
		note: "Fizzy #2264. On, any user with no default role/function tag is blocked by an undismissable modal until they set one — including users who previously chose 'Don't ask again', whose opt-out this deliberately ignores. Off restores the previous dismissible prompt exactly; no data is written or removed either way. Rollback is this switch: a page load or an explicit reload both re-read the flag through the same ~10s server-side flag cache, so either clears a client within ~10s of an admin's change — a reload is not instant, it's bound by that same cache. An already-open gate on an active tab clears within ~40s (that ~10s cache plus the gate's 30s kill-switch poll).",
	},
	PUBLISHING_INBOX: {
		label: "Publishing Suite Inbox",
		description:
			"Replaces the unfiltered publishing topic list with a two-section Inbox — Recently Modified and Suggested — whose rows expand, carry per-user read state, and can be snoozed.",
		envVar: "FABRIC_FEATURE_PUBLISHING_INBOX",
		default: true,
		note: "Fizzy #2265. This is a UI switch: off renders the previous flat list exactly, with no redeploy and no migration. The two write procedures are deliberately NOT behind it — gating them here would mean turning this off strands every snoozed topic, because the un-snooze call would be rejected by the same switch that hid the button. Consequences differ by field and both are intended. Read markers are inert when off, since nothing renders them. Snooze is not: the status chips already exclude snoozed topics and the Snoozed chip already exists, both from the earlier slice and both independent of this flag, so a topic snoozed while this was on stays hidden from the status chips afterwards and is found under the Snoozed chip. Nothing becomes unreachable. Separately, the earlier slice's migration is not gated by this flag and does not reverse: previously deferred topics were moved to Suggestion when it shipped, whatever this is set to. Default ON since the whole of 1D was exercised on staging with it enabled — both sections, read state, all three snooze presets with a rationale, and the decline rationale. Nothing sets this flag's env var in any deployed environment, so this default is what governs there; a deploy can still force it off through the env var, and this switch beats both. One consequence of ON rather than OFF: getFlagOverrides swallows a read error from the override table and returns an empty map, so a fault in that table specifically resolves this flag back ON rather than off, and an admin's OFF is not durable against it.",
	},
	LIVING_DOCS_REFRESH: {
		label: "Living Documents auto-refresh (rollout)",
		description:
			"Whether members can see and use scheduled auto-refresh on a document — the masthead control and the four enrolment procedures.",
		envVar: "FABRIC_FEATURE_LIVING_DOCS_REFRESH_ROLLOUT",
		default: false,
		note: "Fizzy #2210. This is the ROLLOUT switch, deliberately NOT the same gate as LIVING_DOCS_REFRESH_SWEEP. Before this entry existed the rollout lived in a build-time client variable (NEXT_PUBLIC_FABRIC_FEATURE_LIVING_DOCS_REFRESH) that could never change at runtime, while the API tier read a different variable with a different parser — two readers of one capability that nothing kept in agreement. Note what that did and did not cause: when the reported failure was investigated both variables were set true, so the drift was possible rather than actual, and it does not explain that report. It is fixed because a gate that CAN disagree with itself will, not because it did. One runtime-resolved reader now drives the control and the four procedures together. Off: the control does not render and the procedures reject as NOT_FOUND; enrolment rows and any stored proposal survive untouched, so turning it back on restores the previous state with no migration. The env var is a NEW name on purpose — the old FABRIC_FEATURE_LIVING_DOCS_REFRESH is the sweep kill switch and is true in every environment, so inheriting it here would have silently launched the feature on deploy.",
	},
	LIVING_DOCS_REFRESH_SWEEP: {
		label: "Living Documents auto-refresh (sweep kill switch)",
		description:
			"Whether the hourly sweep may run and an in-flight refresh may commit. The brakes, not the accelerator.",
		envVar: "FABRIC_FEATURE_LIVING_DOCS_REFRESH",
		default: false,
		note: "Fizzy #2210. Carries the ORIGINAL env var and the original meaning: TRUE in every environment, prod included, because it is the kill switch rather than the rollout. The sweep re-reads it immediately before it writes, so setting it false stops an unattended AI mid-run without a redeploy (ADR-009 consequence 2). Registered here so that stop is now also reachable from the admin console instead of only a redeploy. Kept separate from LIVING_DOCS_REFRESH so an operator can hold 'not rolled out' and 'brakes armed' at the same time — collapsing them would mean enabling the rollout also arms every enrolled document's sweep in the same action. The registry default is false; deployments that want the brakes armed set the env var, which every current environment already does.",
	},
} as const satisfies Record<string, FeatureFlagDefinition>;

export type FeatureFlagKey = keyof typeof FEATURE_FLAG_REGISTRY;

/** Where a resolved value came from. Surfaced in the admin UI. */
export type FlagSource = "override" | "env" | "default";

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
	return Object.hasOwn(FEATURE_FLAG_REGISTRY, value);
}

export const FEATURE_FLAG_KEYS = Object.keys(
	FEATURE_FLAG_REGISTRY,
) as FeatureFlagKey[];

/**
 * Resolve one flag. Order is override row > env var > registry default.
 *
 * `override === undefined` means "no row", which is distinct from
 * `override === false` ("an admin explicitly turned it off") — the latter must
 * beat a truthy env var, which is the whole point of the feature.
 */
export function resolveFlag(
	key: FeatureFlagKey,
	override: boolean | undefined,
	env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; source: FlagSource } {
	if (override !== undefined) {
		return { enabled: override, source: "override" };
	}

	const definition = FEATURE_FLAG_REGISTRY[key];
	const raw = env[definition.envVar];
	if (raw !== undefined) {
		return { enabled: parseOptInFlag(raw), source: "env" };
	}

	return { enabled: definition.default, source: "default" };
}
