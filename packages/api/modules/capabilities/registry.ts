/**
 * The capability gating matrix, in code (Fizzy #1930).
 *
 * One entry per row of the approved matrix, one named unit test per entry in
 * `__tests__/registry.test.ts`. That pairing is the whole point: a rule cannot
 * quietly drift from the specification without a named test failing, which is
 * the same discipline the project readiness registry uses and for the same
 * reason.
 *
 * ## What is deliberately absent
 *
 * **Every Roadmap row.** The matrix covers Roadmap entry points, context-based
 * recommendation batches and the AI-recommended item lifecycle, and none of
 * those surfaces exist yet — they are built by the Project Suite 3A/3B/3C
 * cards, which land after this one. Writing rules against UI that does not
 * exist would produce dead code that the dead-code gate would reject anyway,
 * and would have to be rewritten once those surfaces take their real shape. The
 * gating requirements for them move into those cards.
 *
 * **Anything the card puts out of scope**: the readiness checklist, request
 * help, permissions, broad empty-state redesign, and the agent chat surfaces.
 *
 * ## Why so many rules end in a warning rather than a block
 *
 * The product direction is explicit that breadth stays discoverable: tabs stay
 * visible, actions gate, and a capability that *can* run on thin input is
 * allowed to, with a warning. Blocking is reserved for the cases where the
 * output would be worthless or the action would simply fail.
 */

import { isStalled, strictest } from "./resolve";
import type { CapabilityEvidence, CapabilityRule, RuleVerdict } from "./types";

const AVAILABLE: RuleVerdict = {
	state: "AVAILABLE",
	reasonKey: null,
	blockingDependency: null,
	remedy: null,
};

/**
 * The codebase verdict every code-dependent capability shares.
 *
 * Seven surfaces depend on the connected repository — Atlas exploration,
 * codebase question answering, the security scan, release notes and three
 * document generators — and the requirements say a source that cannot be
 * indexed must not be treated as usable by ANY of them. One function, so they
 * cannot disagree: a divergence here is exactly the bug the requirement is
 * written to prevent.
 *
 * The ordering below is the severity ladder made concrete, and the two
 * credential cases sit at the top because they outrank a good snapshot. A
 * repository whose token has expired may still have a perfectly good index on
 * disk, and serving answers from it would be telling the user their connection
 * works when it does not.
 */
function codebaseVerdict(
	evidence: CapabilityEvidence,
	now: Date,
	capability: string,
): RuleVerdict {
	const { codebase } = evidence;

	if (!codebase.connected) {
		return {
			state: "HARD_BLOCK",
			reasonKey: "codebase.not-connected",
			blockingDependency: "a connected repository",
			remedy: "CONNECT_REPOSITORY",
		};
	}

	if (codebase.integrationStatus === "TOKEN_EXPIRED") {
		return {
			state: "HARD_BLOCK",
			reasonKey: "codebase.credentials-expired",
			blockingDependency: "valid repository credentials",
			remedy: "RECONNECT_CREDENTIAL",
		};
	}

	// Not a credential verdict. The schema's own comment says so: the token is
	// fine, it simply cannot read this repository, and reconnecting with the
	// same grant changes nothing. Sending someone to the reconnect flow here
	// wastes their time and teaches them the message is unreliable.
	if (codebase.integrationStatus === "REPO_UNAVAILABLE") {
		return {
			state: "HARD_BLOCK",
			reasonKey: "codebase.repository-unreachable",
			blockingDependency: "access to the connected repository",
			remedy: "INSTALL_REPOSITORY_APP",
		};
	}

	if (isStalled(codebase.indexing, "backgroundJob", now)) {
		return {
			state: "HARD_BLOCK",
			reasonKey: "codebase.indexing-stalled",
			blockingDependency: `indexing for ${capability}`,
			remedy: "RETRY_JOB",
			retry: { supported: true, available: false },
		};
	}

	if (codebase.indexing.running) {
		return {
			state: "PROCESSING",
			reasonKey: "codebase.indexing",
			blockingDependency: "repository indexing",
			remedy: "WAIT",
		};
	}

	// The split predicate, and the reason it exists. A failed refresh over a
	// surviving snapshot is a warning: the capability genuinely works, on
	// slightly old data. Hard-blocking here would take Atlas away from projects
	// whose graph is being served successfully at that moment.
	if (codebase.usable && !codebase.healthy) {
		return {
			state: "WARNING",
			reasonKey: "codebase.index-stale",
			blockingDependency: "the most recent indexing run",
			remedy: "RETRY_JOB",
			retry: { supported: true, available: true },
		};
	}

	if (!codebase.usable) {
		return {
			state: codebase.indexing.lastRunFailed
				? "HARD_BLOCK"
				: "PROCESSING",
			reasonKey: codebase.indexing.lastRunFailed
				? "codebase.indexing-failed"
				: "codebase.never-indexed",
			blockingDependency: "a completed index of the repository",
			remedy: codebase.indexing.lastRunFailed ? "RETRY_JOB" : "WAIT",
			retry: codebase.indexing.lastRunFailed
				? { supported: true, available: true }
				: undefined,
		};
	}

	return AVAILABLE;
}

/** Warn when a generation has only the thinnest possible grounding. */
function thinContextWarning(evidence: CapabilityEvidence): RuleVerdict {
	const grounded =
		evidence.context.product > 0 ||
		evidence.documents.usableTypes.size > 0 ||
		evidence.descriptionLength >= 50;
	if (grounded) {
		return AVAILABLE;
	}
	return {
		state: "WARNING",
		reasonKey: "context.thin",
		blockingDependency: "project context",
		remedy: "ADD_CONTEXT",
	};
}

/**
 * Soft-block a generator that has no source of the kind it needs.
 *
 * Soft rather than hard throughout: the page stays usable and the other
 * generators on it keep working — only this one action is out of reach, which
 * is what the action-level-first direction asks for.
 */
function requiresSource(
	present: boolean,
	reasonKey: string,
	dependency: string,
): RuleVerdict {
	return present
		? AVAILABLE
		: {
				state: "SOFT_BLOCK",
				reasonKey,
				blockingDependency: dependency,
				remedy: "ADD_CONTEXT",
			};
}

/** Does the project hold any source that can ground a technical answer? */
function hasTechnicalSource(evidence: CapabilityEvidence): boolean {
	return (
		evidence.context.technical > 0 ||
		evidence.codebase.usable ||
		evidence.documents.usableTypes.has("ARCHITECTURE") ||
		evidence.documents.usableTypes.has("TECHNICAL_SPEC")
	);
}

export const CAPABILITY_RULES: readonly CapabilityRule[] = [
	// ---------------------------------------------------------------- Documents
	{
		key: "documents.generate-prd",
		label: "Generate PRD",
		surface: "documents",
		evaluate: (e) => thinContextWarning(e),
	},
	{
		key: "documents.generate-business-case",
		label: "Generate Business Case",
		surface: "documents",
		evaluate: (e) => thinContextWarning(e),
	},
	{
		key: "documents.generate-proposal",
		label: "Generate Proposal",
		surface: "documents",
		evaluate: (e) => thinContextWarning(e),
	},
	{
		key: "documents.generate-architecture",
		label: "Generate Architecture Document",
		surface: "documents",
		evaluate: (e) =>
			requiresSource(
				hasTechnicalSource(e) ||
					e.documents.usableTypes.has("PRD") ||
					e.documents.usableTypes.has("PROPOSAL") ||
					e.documents.usableTypes.has("BUSINESS_CASE"),
				"documents.no-architecture-source",
				"a product or architecture source",
			),
	},
	{
		key: "documents.generate-tech-spec",
		label: "Generate Technical Specification",
		surface: "documents",
		evaluate: (e) =>
			requiresSource(
				hasTechnicalSource(e) || e.documents.usableTypes.has("PRD"),
				"documents.no-technical-source",
				"a PRD, architecture document or indexed codebase",
			),
	},
	{
		key: "documents.generate-api-spec",
		label: "Generate API Specification",
		surface: "documents",
		evaluate: (e) =>
			requiresSource(
				hasTechnicalSource(e) ||
					e.documents.usableTypes.has("TECHNICAL_SPEC"),
				"documents.no-api-source",
				"an API-relevant source",
			),
	},
	{
		key: "documents.generate-qa-strategy",
		label: "Generate QA Strategy",
		surface: "documents",
		evaluate: (e) =>
			requiresSource(
				e.documents.usableTypes.has("PRD") || e.context.product > 0,
				"documents.no-requirements-source",
				"a PRD or equivalent requirements context",
			),
	},

	// ------------------------------------------------------------------ Context
	{
		key: "context.use-linked-source",
		label: "Use a linked knowledge-base source",
		surface: "context",
		evaluate: (e, now) => {
			if (isStalled(e.context.processing, "backgroundJob", now)) {
				return {
					state: "HARD_BLOCK",
					reasonKey: "context.ingestion-stalled",
					blockingDependency: "source ingestion",
					remedy: "RETRY_JOB",
					retry: { supported: true, available: true },
				};
			}
			if (e.context.processing.running) {
				return {
					state: "PROCESSING",
					reasonKey: "context.ingesting",
					blockingDependency: "source ingestion",
					remedy: "WAIT",
				};
			}
			return AVAILABLE;
		},
	},

	// -------------------------------------------------------------------- Atlas
	{
		key: "atlas.explore",
		label: "Explore the codebase graph",
		surface: "atlas",
		evaluate: (e, now) => codebaseVerdict(e, now, "Atlas"),
	},
	{
		key: "atlas.codebase-qa",
		label: "Ask a question about the codebase",
		surface: "atlas",
		evaluate: (e, now) => codebaseVerdict(e, now, "codebase questions"),
	},

	// ----------------------------------------------------------------- Security
	{
		key: "security.run-scan",
		label: "Run a security scan",
		surface: "security",
		evaluate: (e, now) => {
			// Only gate on the codebase when an engine that actually reads
			// repository code is switched on.
			//
			// The requirement says a security scan needs a connected, readable
			// codebase, and taken literally that removes a working capability:
			// the two engines that run by DEFAULT are AI reviewers over
			// documents and features, and they need no repository whatsoever.
			// The repository scanners — Semgrep and the git-history secret
			// scan — are both opt-in and off by default. Blocking the whole
			// action on a repository would therefore take spec review away
			// from exactly the projects that have nothing but specs, which is
			// the audience this suite exists to help.
			const prerequisites: RuleVerdict[] = [];
			if (e.scan.requiresCodebase) {
				prerequisites.push(
					codebaseVerdict(e, now, "the security scan"),
				);
			}
			// Scans are the one source with no heartbeat, so their staleness is
			// measured from when the run started and the window is necessarily
			// generous. A sweep now closes abandoned rows as well; this is what
			// the page shows in the gap before it next runs.
			if (isStalled(e.scan, "projectScan", now)) {
				prerequisites.push({
					state: "HARD_BLOCK",
					reasonKey: "scan.stalled",
					blockingDependency: "the previous scan run",
					remedy: "RETRY_JOB",
					retry: { supported: true, available: true },
				});
			} else if (e.scan.running) {
				prerequisites.push({
					state: "PROCESSING",
					reasonKey: "scan.running",
					blockingDependency: "the running scan",
					remedy: "WAIT",
				});
			}

			// Collapsed rather than returned in order. Returning the first
			// non-available verdict looks equivalent and is not: a codebase that
			// is merely stale yields a WARNING, and an early return would hand
			// that back while a scan sat stalled behind it — the weaker state
			// winning purely because it was checked first. The composite rule
			// exists precisely so severity, not evaluation order, decides.
			return strictest(prerequisites);
		},
	},

	// ------------------------------------------------------------------ Reports
	//
	// No rule, deliberately, and the reason is structural rather than a matter
	// of effort.
	//
	// Reports are TENANT-scoped: `TemplateInstance` carries a user and an
	// organization and no project at all, and the whole reports module contains
	// no reference to a project id. Every gate here is resolved for one project,
	// so a report gate would either need a project that does not exist or would
	// have to answer about the whole tenant — and a tenant-wide answer applied
	// to one report refuses a correctly configured report because some unrelated
	// one is unconfigured.
	//
	// The requirement it would have served — template cards stay visible in a
	// needs-setup state explaining what to connect, rather than being hidden —
	// is already met, by code that predates this feature and is better placed
	// for it: `apps/web/modules/saas/reports/lib/report-readiness.ts` derives it
	// per instance and feeds the banner, the connection pill and the readiness
	// rail from one source of truth. It also reads live connection diagnostics
	// the server cannot reproduce, so moving it here would lose information
	// rather than gain consistency.
	//
	// A report-scoped gate belongs in a card that can give reports a project, or
	// can accept tenant scope deliberately. It does not belong bolted onto a
	// project-scoped resolver.

	// ------------------------------------------------------------ Release notes
	{
		key: "release-notes.generate",
		label: "Generate release notes",
		surface: "release-notes",
		evaluate: (e, now) => {
			// v1 is codebase-driven by explicit decision. A project-management
			// system may enrich the output later but never substitutes for the
			// repository, so the gate asks only about the codebase.
			if (!e.releaseNotes.codebaseUsable) {
				return codebaseVerdict(e, now, "release notes");
			}
			return AVAILABLE;
		},
	},

	// ----------------------------------------------------------------- Settings
	{
		key: "settings.repository-connection",
		label: "Repository connection status",
		surface: "settings",
		evaluate: (e) => {
			// Settings warn, never block — this is where people come to satisfy
			// the prerequisite in the first place, so taking the page away from
			// them would be self-defeating. The value of this rule is honesty:
			// a connection that cannot be used must not read as Connected.
			if (e.codebase.integrationStatus === "TOKEN_EXPIRED") {
				return {
					state: "WARNING",
					reasonKey: "settings.credentials-expired",
					blockingDependency: "valid repository credentials",
					remedy: "RECONNECT_CREDENTIAL",
				};
			}
			if (e.codebase.integrationStatus === "REPO_UNAVAILABLE") {
				return {
					state: "WARNING",
					reasonKey: "settings.repository-unreachable",
					blockingDependency: "access to the connected repository",
					remedy: "INSTALL_REPOSITORY_APP",
				};
			}
			if (e.codebase.connected && !e.codebase.healthy) {
				return {
					state: "WARNING",
					reasonKey: "settings.connection-degraded",
					blockingDependency: "the most recent indexing run",
					remedy: "RETRY_JOB",
					retry: { supported: true, available: true },
				};
			}
			return AVAILABLE;
		},
	},
];

/** Look one up without scanning the array at every call site. */
export const CAPABILITY_RULES_BY_KEY: ReadonlyMap<string, CapabilityRule> =
	new Map(CAPABILITY_RULES.map((rule) => [rule.key, rule]));
