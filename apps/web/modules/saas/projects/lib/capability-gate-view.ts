/**
 * Turning a resolved capability gate into the copy and affordances a surface
 * renders (Fizzy #1930).
 *
 * A plain function, for the same reason `report-readiness.ts` is one: every
 * surface that gates — a banner, a badge, a disabled button — has to reach the
 * same verdict about the same gate, and the only way to guarantee that is to
 * derive all three from one place that can be unit-tested without a DOM. It
 * performs NO network calls and reads nothing but the gate handed to it.
 *
 * ## Why this returns translation keys rather than sentences
 *
 * The readiness precedent returns English. This cannot: the copy lives in
 * `packages/i18n/translations/en.json`, so a sentence baked in here would be a
 * second, untranslated source of truth. Returning key paths keeps the function
 * pure *and* keeps the words where the translators can reach them — the caller
 * resolves them with `useTranslations("projects.capabilityGates")`. Every key
 * below is relative to that namespace.
 *
 * ## Why title and body key off `reasonKey` but the button keys off `remedy`
 *
 * They answer different questions and the server separates them on purpose.
 * `reasonKey` is what is wrong, and it is specific enough to write a real
 * sentence about. `remedy` is what would fix it, and two different reasons can
 * share one fix. Deriving the button from the reason would work today and
 * break the first time a new rule reuses an existing remedy.
 *
 * The case that makes this non-negotiable is the repository. An expired token
 * and an unreachable repository are both "the codebase is not usable", but
 * `RECONNECT_CREDENTIAL` and `INSTALL_REPOSITORY_APP` are different fixes, and
 * the repository status enum's own schema comment says reconnecting cannot
 * clear the second one. Sending those users to the reconnect flow costs them a
 * round trip and teaches them the message is not worth reading.
 *
 * ## Why there is no generic "gated action" component
 *
 * There was one, briefly, and nothing could use it. Every surface wired so far
 * — the security scan button, the create-document dialog — arrived with its own
 * button and its own `disabled` expression already assembled from two or three
 * conditions. What they needed was one more boolean to fold in, which is what
 * `useCapabilityGate(key).blocked` gives them; a wrapper component that owned
 * the button's markup had nowhere to sit, and its vertical reason paragraph
 * broke the one header row it was tried in.
 *
 * So the composition is: read `blocked` into the `disabled` the page already
 * has, and render one `CapabilityGateBanner` for the explanation. Not both for
 * the same capability on the same surface — the banner already carries the
 * reason, and a second copy of it beside the button is the same sentence twice.
 *
 * A badge component went the same way for the same reason, which is why nothing
 * here produces a short state label any more.
 */

import type {
	CapabilityGate,
	CapabilityState,
	RemedyKind,
	RetryAffordance,
} from "@repo/api/modules/capabilities/types";

/** Colour intent. Maps to design tokens at render time, never to a hex. */
export type GateTone = "destructive" | "warning" | "info";

/**
 * What the gate's call to action does.
 *
 * `navigate` sends the viewer somewhere they can satisfy the dependency,
 * `retry` re-runs the job that failed, and `none` is the honest answer for a
 * job that is simply still running — there is nothing to press.
 */
type GateCtaKind = "navigate" | "retry" | "none";

/**
 * Where a `navigate` CTA points, named abstractly.
 *
 * Deliberately not an href: this module has no business knowing the project's
 * route shape, and a personal and an organization project reach the same
 * settings page by different paths. The surface rendering the gate already
 * knows its own base path and maps this to it.
 */
export type GateDestination =
	| "repository"
	| "code-search"
	| "context"
	| "documents"
	| "integrations"
	| "pm-settings";

/**
 * The states that render something. `AVAILABLE` and `HIDDEN` do not.
 *
 * Not exported, and neither is `GateCtaKind`: both are reachable as
 * `CapabilityGateView["state"]` / `["ctaKind"]`, and the dead-code gate counts
 * an exported type nothing imports as dead. Export them when a consumer
 * genuinely needs to name one.
 */
type VisibleGateState = Exclude<CapabilityState, "AVAILABLE" | "HIDDEN">;

export interface CapabilityGateView {
	capabilityKey: string;
	state: VisibleGateState;
	reasonKey: string;
	tone: GateTone;
	/** Key for the headline. */
	title: string;
	/** Key for the explanation. Interpolate with `params`. */
	body: string;
	/**
	 * ICU values for `body`.
	 *
	 * `dependency` is the server's own naming of what is missing. The
	 * requirements are explicit that a composite message must name the missing
	 * prerequisite rather than announce a verdict, so it is carried through
	 * rather than summarised away.
	 */
	params: { dependency: string };
	ctaLabel: string | null;
	ctaKind: GateCtaKind;
	ctaTarget: GateDestination | null;
	/**
	 * Whether the gated action itself must be disabled.
	 *
	 * A warning never disables anything — the capability genuinely runs, just
	 * on thinner input than it would like. Everything else does.
	 */
	blocksAction: boolean;
	/** Only a warning may be silenced. Every other state is not a viewer's to overrule. */
	dismissible: boolean;
	retry: RetryAffordance;
}

const TONE_BY_STATE: Record<VisibleGateState, GateTone> = {
	HARD_BLOCK: "destructive",
	SOFT_BLOCK: "warning",
	PROCESSING: "info",
	WARNING: "warning",
};

/** Copy for a reason this build does not know, written per state. */
const FALLBACK_BY_STATE: Record<VisibleGateState, string> = {
	HARD_BLOCK: "fallback.hardBlock",
	SOFT_BLOCK: "fallback.softBlock",
	PROCESSING: "fallback.processing",
	WARNING: "fallback.warning",
};

/**
 * One entry per remedy, and the table is exhaustive by type rather than by
 * discipline — adding a `RemedyKind` to the contract fails `pnpm type-check`
 * here until it has copy and a destination of its own.
 */
const REMEDY: Record<
	RemedyKind,
	{
		ctaKind: GateCtaKind;
		target: GateDestination | null;
		label: string | null;
	}
> = {
	CONNECT_REPOSITORY: {
		ctaKind: "navigate",
		target: "repository",
		label: "remedy.connectRepository",
	},
	RECONNECT_CREDENTIAL: {
		ctaKind: "navigate",
		target: "repository",
		label: "remedy.reconnectCredential",
	},
	// Not a reconnect, and the copy behind this key must never say so. The
	// credential is valid; it simply does not reach this repository, so the fix
	// is granting access to it rather than signing in again.
	INSTALL_REPOSITORY_APP: {
		ctaKind: "navigate",
		target: "repository",
		label: "remedy.installRepositoryApp",
	},
	ADD_CONTEXT: {
		ctaKind: "navigate",
		target: "context",
		label: "remedy.addContext",
	},
	GENERATE_PREREQUISITE_DOCUMENT: {
		ctaKind: "navigate",
		target: "documents",
		label: "remedy.generatePrerequisiteDocument",
	},
	CONFIGURE_INTEGRATION: {
		ctaKind: "navigate",
		target: "integrations",
		label: "remedy.configureIntegration",
	},
	// The tool is connected; what is missing is the board, which is chosen in
	// Project Settings rather than on the Integrations page.
	CONFIGURE_PM_BOARD: {
		ctaKind: "navigate",
		target: "pm-settings",
		label: "remedy.configurePmBoard",
	},
	ENABLE_CODE_SEARCH: {
		ctaKind: "navigate",
		target: "code-search",
		label: "remedy.enableCodeSearch",
	},
	RETRY_JOB: { ctaKind: "retry", target: null, label: "remedy.retryJob" },
	// Nothing to press. A running job needs patience, not a button, and
	// offering one would imply the wait is the viewer's problem to solve.
	WAIT: { ctaKind: "none", target: null, label: null },
};

/**
 * A retry whose label says more than "Try again".
 *
 * An index that never ran has nothing to try AGAIN — the button starts the
 * first run, and saying so is the difference between a person pressing it and
 * a person wondering what failed.
 */
const RETRY_LABEL_BY_REASON: Readonly<Record<string, string>> = {
	"codebase.never-indexed": "remedy.startIndexing",
};

/**
 * Processing reasons that do not disable the action.
 *
 * A generator whose source is still generating is queued by the generation
 * workflow's own dependency wait, and the server lets the request through for
 * exactly that reason. Disabling the button here would make a person wait by
 * hand for something the queue waits for on their behalf.
 */
const QUEUED_BY_DEPENDENCY: ReadonlySet<string> = new Set([
	"documents.source-processing",
]);

/**
 * Every reason the rule registry can currently produce.
 *
 * Listed rather than derived because the registry lives in `@repo/api` behind
 * a module that reaches the database, and pulling it into the browser bundle
 * to read twenty strings would be a poor trade. The cost is that a reason
 * added server-side arrives here unknown — so the fallback below is not
 * defensive decoration, it is the path a newly added rule actually takes until
 * its copy lands.
 */
const KNOWN_REASON_KEYS: ReadonlySet<string> = new Set([
	"codebase.not-connected",
	"codebase.credentials-expired",
	"codebase.repository-unreachable",
	"codebase.indexing-stalled",
	"codebase.indexing",
	"codebase.index-stale",
	"codebase.indexing-failed",
	"codebase.never-indexed",
	"codebase.code-search-off",
	"codebase.indexing-unavailable",
	"context.thin",
	"context.ingestion-stalled",
	"context.ingesting",
	"documents.no-architecture-source",
	"documents.no-technical-source",
	"documents.no-api-source",
	"documents.no-requirements-source",
	"documents.source-processing",
	"documents.refresh-sources-processing",
	"documents.refresh-nothing-to-read",
	// A scan block does not imply a repository problem: the rule consults the
	// codebase only when a repository-reading engine is enabled, and it
	// collapses its prerequisites by severity rather than reporting the first
	// one that is not available. The copy behind these stays about the scan.
	"scan.stalled",
	"scan.running",
	// No reports entry. Reports are tenant-scoped with no project link, so a
	// project-scoped gate could never be right for one — `report-readiness.ts`
	// derives that per instance instead.
	"settings.credentials-expired",
	"settings.repository-unreachable",
	"settings.connection-degraded",
	"settings.no-linked-channel",
	"roadmap.pm-not-connected",
	"roadmap.pm-no-board",
	"roadmap.pm-read-only",
	"roadmap.pm-sync-running",
	"roadmap.recommend.context-insufficient",
	"roadmap.do-both.needs-pm",
	"roadmap.do-both.needs-board",
	"roadmap.do-both.needs-context",
	// No `roadmap.no-eligible-ai-batch`: that reason only ever arrives on a
	// HIDDEN gate, which builds no view. Its copy is read by the batch
	// removal dialog's empty state.
]);

/**
 * Build what a surface should render for one gate, or `null` for nothing.
 *
 * Three cases render nothing, and centralising them here is the point — a
 * component that forgets one is a component that explains a working button or
 * resurrects a warning somebody dismissed:
 *
 *  - `AVAILABLE` — the capability works. No banner, no disabled state.
 *  - `HIDDEN` — there is nothing for the capability to act on, so the action
 *    leaves the page. That is the surface's job, not a banner's: it reads
 *    `useCapabilityGate(key).hidden` and does not render the action at all.
 *  - `suppressed` — this viewer silenced this warning. The server still sends
 *    the gate (it flags rather than filters, so a restore control can know
 *    there is something to restore), which means the hiding has to happen here.
 */
export function buildCapabilityGateView(
	gate: CapabilityGate,
	/**
	 * Whether this viewer dismissed this warning for the browser session. Held
	 * client-side only — see `session-dismissals.ts` — and passed in so this
	 * function stays pure.
	 */
	dismissedForSession = false,
): CapabilityGateView | null {
	if (gate.state === "HIDDEN" || gate.state === "AVAILABLE") {
		return null;
	}
	if (gate.suppressed) {
		return null;
	}
	// Only a warning can be dismissed, for the session as for any duration: a
	// stale session entry for a gate that has since become a block must not
	// hide the block.
	if (dismissedForSession && gate.state === "WARNING") {
		return null;
	}

	const state = gate.state as VisibleGateState;
	const remedy = gate.remedy ? REMEDY[gate.remedy] : null;

	// A reason the server names but this build has no copy for still has to say
	// something true. The fallback is written per state and names the missing
	// dependency, which is the part that actually helps.
	const known =
		gate.reasonKey !== null && KNOWN_REASON_KEYS.has(gate.reasonKey);
	const copyBase = known
		? `reason.${gate.reasonKey}`
		: FALLBACK_BY_STATE[state];

	return {
		capabilityKey: gate.capabilityKey,
		state,
		reasonKey: gate.reasonKey ?? "",
		tone: TONE_BY_STATE[state],
		title: `${copyBase}.title`,
		body: `${copyBase}.body`,
		params: { dependency: gate.blockingDependency ?? "" },
		ctaLabel:
			(gate.reasonKey && RETRY_LABEL_BY_REASON[gate.reasonKey]) ??
			remedy?.label ??
			null,
		ctaKind: remedy?.ctaKind ?? "none",
		ctaTarget: remedy?.target ?? null,
		blocksAction:
			state !== "WARNING" &&
			!(
				gate.reasonKey !== null &&
				QUEUED_BY_DEPENDENCY.has(gate.reasonKey)
			),
		dismissible: state === "WARNING",
		retry: gate.retry,
	};
}
