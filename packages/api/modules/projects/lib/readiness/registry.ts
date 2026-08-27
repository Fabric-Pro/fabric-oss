/**
 * Project readiness rule registry — the code form of the approved checklist
 * spreadsheet (Fizzy #2165, revision of 19 August).
 *
 * One entry per sheet row, one unit test per entry. That pairing is the point:
 * a rule cannot quietly drift from the sheet without a named test failing.
 *
 * ## Why 26 rules and not 29
 *
 * The three Project Basics rows — project description, project phase, expected
 * development start date — are annotated in the sheet as "will not be shown on
 * the checklist" because the creation form collects them. They are enforced
 * there instead: an item the panel can never display cannot be actioned, and a
 * level calculated from items the user cannot see reports a failure nobody can
 * fix.
 *
 * That enforcement is now real — the wizard requires a name, a description over
 * MIN_DESCRIPTION_LENGTH, a phase, and an expected start date on Discovery — so
 * the three document rows below carry no "description exists OR a context
 * source exists" dependency. The disjunction is always satisfied for anything
 * created through the wizard.
 *
 * Known residual: `projects.create` keeps `description` and `projectPhase`
 * optional by design, because the public API, the v1 API, the CLI and the agent
 * tool all create projects and none can be made to ask. A project arriving that
 * way with no description is graded as though it had one. Accepted rather than
 * unnoticed — see the 20 August direction that these three belong to creation.
 *
 * ## Detection verifies success, not attempt
 *
 * Every rule below asks whether the underlying thing actually *worked*. A
 * document that has never produced content, a scan that started and died, a
 * context source whose extraction failed — none of them count. This is the
 * single most important property of the sheet's 19 August revision.
 *
 * What it does NOT mean is that a later re-run un-works the thing. Re-running a
 * generation flips the document row's status, and re-indexing flips the code
 * index's, without either taking away what the project already has; both reads
 * key on the durable fact instead of the transient status (see `evidence.ts`).
 */

import type { ProjectPhase } from "@repo/database";
import type { ReadinessRule } from "./types";

/**
 * `dependsOn` is a DISJUNCTION: the dependency is satisfied when **any** listed
 * key is complete. Every dependency cell in the sheet is an "either A or B"
 * phrasing, so an OR is the faithful reading; single-element lists behave
 * identically either way.
 */
export const READINESS_RULES: readonly ReadinessRule[] = [
	// ── Project Basics ───────────────────────────────────────────────────────
	{
		key: "feature-snapshot",
		category: "PROJECT_BASICS",
		i18nKey: "readiness.items.featureSnapshot",
		ctaLabelKey: "readiness.cta.featureSnapshot",
		target: { kind: "tab", tab: "overview" },
		needLevel: phase({ discovery: "SHOULD", development: "SHOULD" }),
		detect: (e) => e.featureCount >= 1,
	},
	{
		key: "tech-stack",
		category: "PROJECT_BASICS",
		i18nKey: "readiness.items.techStack",
		ctaLabelKey: "readiness.cta.techStack",
		target: { kind: "tab", tab: "overview" },
		needLevel: phase({ discovery: "SHOULD", development: "SHOULD" }),
		detect: (e) => e.techStackCount >= 1,
	},

	// ── Context & Connections ────────────────────────────────────────────────
	{
		key: "context-source",
		category: "CONTEXT_AND_CONNECTIONS",
		i18nKey: "readiness.items.contextSource",
		ctaLabelKey: "readiness.cta.contextSource",
		target: { kind: "tab", tab: "context" },
		needLevel: phase({ discovery: "SHOULD", development: "SHOULD" }),
		supersededBy: ["prd", "business-case", "proposal"],
		detect: (e) => e.indexedContext.total >= 1,
		inProgress: (e) => e.inFlight.context.total > 0,
	},
	{
		key: "additional-context-sources",
		category: "CONTEXT_AND_CONNECTIONS",
		i18nKey: "readiness.items.additionalContextSources",
		ctaLabelKey: "readiness.cta.additionalContextSources",
		target: { kind: "tab", tab: "context" },
		needLevel: phase({ discovery: "SHOULD", development: "SHOULD" }),
		supersededBy: ["prd", "business-case", "proposal"],
		detect: (e) => e.indexedContext.total >= 2,
		inProgress: (e) => e.inFlight.context.total > 0,
	},
	{
		// Settings, not the Context tab. What satisfies this rule is a chat
		// MONITOR being enabled (see `detect`), and monitors are configured in
		// Project Settings -> Knowledge, alongside meeting transcripts. Sending
		// people to Context asked them to add a context source, which never
		// satisfies it — "add chat app by clicking add context, like what?"
		key: "chat-app-connected",
		category: "CONTEXT_AND_CONNECTIONS",
		i18nKey: "readiness.items.chatAppConnected",
		ctaLabelKey: "readiness.cta.chatAppConnected",
		target: { kind: "settings", subTab: "knowledge" },
		needLevel: phase({ discovery: "SHOULD", development: "SHOULD" }),
		detect: (e) => e.chat.slackConnected || e.chat.teamsConnected,
	},
	{
		key: "meeting-transcripts",
		category: "CONTEXT_AND_CONNECTIONS",
		i18nKey: "readiness.items.meetingTranscripts",
		ctaLabelKey: "readiness.cta.meetingTranscripts",
		target: { kind: "settings", subTab: "knowledge" },
		needLevel: phase({ discovery: "SHOULD", development: "SHOULD" }),
		dependsOn: ["chat-app-connected"],
		detect: (e) => e.indexedContext.meetingTranscripts >= 1,
		inProgress: (e) => e.inFlight.context.meetingTranscripts > 0,
	},
	{
		key: "pm-system-connected",
		category: "CONTEXT_AND_CONNECTIONS",
		i18nKey: "readiness.items.pmSystemConnected",
		ctaLabelKey: "readiness.cta.pmSystemConnected",
		target: { kind: "settings", subTab: "development" },
		needLevel: phase({ discovery: "SHOULD", development: "SHOULD" }),
		detect: (e) => e.pm.connected,
	},
	{
		key: "codebase-connected",
		category: "CONTEXT_AND_CONNECTIONS",
		i18nKey: "readiness.items.codebaseConnected",
		ctaLabelKey: "readiness.cta.codebaseConnected",
		target: { kind: "settings", subTab: "development" },
		needLevel: phase({ discovery: "SHOULD", development: "MUST" }),
		detect: (e) => e.code.repositoryConnected && e.code.analysisCompleted,
		inProgress: (e) => e.inFlight.codebaseIndexing,
	},
	{
		// Notion only for v1. Confluence connects and records the source, but no
		// ingestion exists for it, so "indexed successfully" can never become
		// true on Confluence alone. Shipping the rule as written would leave a
		// permanently unsatisfiable item on any Confluence-only project.
		key: "wiki-connected",
		category: "CONTEXT_AND_CONNECTIONS",
		i18nKey: "readiness.items.wikiConnected",
		ctaLabelKey: "readiness.cta.wikiConnected",
		target: { kind: "tab", tab: "context" },
		needLevel: phase({ discovery: "COULD", development: "SHOULD" }),
		detect: (e) => e.indexedContext.notionSources >= 1,
		inProgress: (e) => e.inFlight.context.notionSources > 0,
	},
	{
		key: "knowledge-base",
		category: "CONTEXT_AND_CONNECTIONS",
		i18nKey: "readiness.items.knowledgeBase",
		ctaLabelKey: "readiness.cta.knowledgeBase",
		target: { kind: "tab", tab: "context" },
		needLevel: phase({ discovery: "COULD", development: "SHOULD" }),
		detect: (e) => e.indexedContext.knowledgeBaseLinks >= 1,
		inProgress: (e) => e.inFlight.context.knowledgeBaseLinks > 0,
	},

	// ── Documents ────────────────────────────────────────────────────────────
	// The sheet's "Either A) Project description / brief exists or B) At least
	// one context source added" disjunction, restored. It had been dropped on
	// the assumption description was guaranteed at creation; it is not, and a
	// project created through the public API, the CLI or an agent tool can
	// still arrive with none.
	{
		key: "business-case",
		category: "DOCUMENTS",
		i18nKey: "readiness.items.businessCase",
		ctaLabelKey: "readiness.cta.businessCase",
		target: { kind: "tab", tab: "documents" },
		needLevel: phase({ discovery: "SHOULD", development: "COULD" }),
		supersededBy: ["prd"],
		detect: (e) => e.completeDocumentTypes.has("BUSINESS_CASE"),
		inProgress: (e) => e.inFlight.documentTypes.has("BUSINESS_CASE"),
	},
	{
		key: "proposal",
		category: "DOCUMENTS",
		i18nKey: "readiness.items.proposal",
		ctaLabelKey: "readiness.cta.proposal",
		target: { kind: "tab", tab: "documents" },
		needLevel: phase({ discovery: "MUST", development: "COULD" }),
		supersededBy: ["prd"],
		detect: (e) => e.completeDocumentTypes.has("PROPOSAL"),
		inProgress: (e) => e.inFlight.documentTypes.has("PROPOSAL"),
	},
	{
		key: "prd",
		category: "DOCUMENTS",
		i18nKey: "readiness.items.prd",
		ctaLabelKey: "readiness.cta.prd",
		target: { kind: "tab", tab: "documents" },
		needLevel: phase({ discovery: "MUST", development: "MUST" }),
		detect: (e) => e.completeDocumentTypes.has("PRD"),
		inProgress: (e) => e.inFlight.documentTypes.has("PRD"),
	},
	{
		key: "architecture",
		category: "DOCUMENTS",
		i18nKey: "readiness.items.architecture",
		ctaLabelKey: "readiness.cta.architecture",
		target: { kind: "tab", tab: "documents" },
		needLevel: phase({ discovery: "COULD", development: "MUST" }),
		dependsOn: ["prd", "proposal", "business-case", "codebase-connected"],
		detect: (e) => e.completeDocumentTypes.has("ARCHITECTURE"),
		inProgress: (e) => e.inFlight.documentTypes.has("ARCHITECTURE"),
	},
	{
		key: "api-spec",
		category: "DOCUMENTS",
		i18nKey: "readiness.items.apiSpec",
		ctaLabelKey: "readiness.cta.apiSpec",
		target: { kind: "tab", tab: "documents" },
		needLevel: phase({ discovery: "COULD", development: "SHOULD" }),
		dependsOn: ["architecture"],
		detect: (e) => e.completeDocumentTypes.has("API_SPEC"),
		inProgress: (e) => e.inFlight.documentTypes.has("API_SPEC"),
	},
	{
		key: "technical-spec",
		category: "DOCUMENTS",
		i18nKey: "readiness.items.technicalSpec",
		ctaLabelKey: "readiness.cta.technicalSpec",
		target: { kind: "tab", tab: "documents" },
		needLevel: phase({ discovery: "COULD", development: "SHOULD" }),
		dependsOn: ["architecture"],
		detect: (e) => e.completeDocumentTypes.has("TECHNICAL_SPEC"),
		inProgress: (e) => e.inFlight.documentTypes.has("TECHNICAL_SPEC"),
	},
	{
		key: "qa-strategy",
		category: "DOCUMENTS",
		i18nKey: "readiness.items.qaStrategy",
		ctaLabelKey: "readiness.cta.qaStrategy",
		target: { kind: "tab", tab: "documents" },
		needLevel: phase({ discovery: "COULD", development: "SHOULD" }),
		dependsOn: ["prd"],
		detect: (e) => e.completeDocumentTypes.has("QA_STRATEGY"),
		inProgress: (e) => e.inFlight.documentTypes.has("QA_STRATEGY"),
	},

	// ── Roadmap ──────────────────────────────────────────────────────────────
	{
		key: "roadmap-populated",
		category: "ROADMAP",
		i18nKey: "readiness.items.roadmapPopulated",
		ctaLabelKey: "readiness.cta.roadmapPopulated",
		target: { kind: "tab", tab: "stories" },
		needLevel: phase({ discovery: "SHOULD", development: "MUST" }),
		dependsOn: ["prd", "proposal", "business-case", "pm-system-connected"],
		detect: (e) => e.roadmapItemCount >= 1,
	},
	{
		// Connection alone does NOT sync. There is an explicit per-project
		// auto-push toggle, and read-only mode separately blocks every outbound
		// write, so this is three conditions rather than one.
		key: "pm-sync-enabled",
		category: "ROADMAP",
		i18nKey: "readiness.items.pmSyncEnabled",
		ctaLabelKey: "readiness.cta.pmSyncEnabled",
		target: { kind: "settings", subTab: "development" },
		needLevel: phase({ discovery: "SHOULD", development: "MUST" }),
		dependsOn: ["pm-system-connected"],
		detect: (e) =>
			e.pm.connected && e.pm.autoPushEnabled && !e.pm.readOnlyMode,
	},
	{
		key: "terminal-statuses",
		category: "ROADMAP",
		i18nKey: "readiness.items.terminalStatuses",
		ctaLabelKey: "readiness.cta.terminalStatuses",
		target: { kind: "settings", subTab: "development" },
		needLevel: phase({ discovery: "SHOULD", development: "MUST" }),
		dependsOn: ["pm-system-connected"],
		detect: (e) => e.pm.autoCloseEnabled && e.pm.terminalStatusCount >= 1,
	},

	// ── Members ──────────────────────────────────────────────────────────────
	{
		// Accepted members only — a pending invitation is not a teammate yet.
		key: "team-members",
		category: "MEMBERS",
		i18nKey: "readiness.items.teamMembers",
		ctaLabelKey: "readiness.cta.teamMembers",
		target: { kind: "settings", subTab: "members" },
		needLevel: phase({ discovery: "SHOULD", development: "MUST" }),
		detect: (e) => e.acceptedMemberCount >= 2,
	},

	// ── Automation ───────────────────────────────────────────────────────────
	{
		key: "work-capture-transcripts",
		category: "AUTOMATION",
		i18nKey: "readiness.items.workCaptureTranscripts",
		ctaLabelKey: "readiness.cta.workCaptureTranscripts",
		target: { kind: "settings", subTab: "knowledge" },
		needLevel: phase({ discovery: "SHOULD", development: "MUST" }),
		dependsOn: ["meeting-transcripts"],
		detect: (e) =>
			e.indexedContext.meetingTranscripts >= 1 &&
			e.chat.transcriptAutoAnalyzeEnabled,
	},
	{
		// Slack OR Teams. The product has three independent monitors and the
		// original rule named only the Teams one, which made this Must
		// impossible to complete on a Slack-only project.
		key: "work-capture-chat",
		category: "AUTOMATION",
		i18nKey: "readiness.items.workCaptureChat",
		ctaLabelKey: "readiness.cta.workCaptureChat",
		target: { kind: "settings", subTab: "knowledge" },
		needLevel: phase({ discovery: "SHOULD", development: "MUST" }),
		dependsOn: ["chat-app-connected"],
		detect: (e) =>
			e.chat.slackChannelMonitorEnabled ||
			e.chat.teamsChannelMonitorEnabled ||
			e.chat.teamsChatMonitorEnabled,
	},
	{
		key: "release-notes",
		category: "AUTOMATION",
		i18nKey: "readiness.items.releaseNotes",
		ctaLabelKey: "readiness.cta.releaseNotes",
		target: { kind: "settings", subTab: "newsletter" },
		needLevel: phase({
			discovery: "NOT_APPLICABLE",
			development: "SHOULD",
		}),
		dependsOn: ["codebase-connected"],
		detect: (e) => e.newsletterEnabled,
	},

	// ── Valuable Features ────────────────────────────────────────────────────
	{
		// The sheet asks for "indexed successfully AND Atlas opened at least
		// once". Nothing in the product records a tab being opened, so the
		// closest honest signal is that an Atlas graph exists for the project —
		// which only happens once someone has run an analysis from that tab.
		key: "atlas-explored",
		category: "VALUABLE_FEATURES",
		i18nKey: "readiness.items.atlasExplored",
		ctaLabelKey: "readiness.cta.atlasExplored",
		target: { kind: "tab", tab: "atlas" },
		needLevel: phase({
			discovery: "NOT_APPLICABLE",
			development: "SHOULD",
		}),
		dependsOn: ["codebase-connected"],
		detect: (e) => e.code.analysisCompleted && e.code.atlasAnalysisExists,
		inProgress: (e) => e.inFlight.codebaseIndexing,
	},
	{
		// A scan that ran and failed is not a completed scan.
		key: "security-scan",
		category: "VALUABLE_FEATURES",
		i18nKey: "readiness.items.securityScan",
		ctaLabelKey: "readiness.cta.securityScan",
		target: { kind: "tab", tab: "security" },
		needLevel: phase({
			discovery: "NOT_APPLICABLE",
			development: "SHOULD",
		}),
		dependsOn: ["codebase-connected"],
		detect: (e) => e.successfulScanExists,
		inProgress: (e) => e.inFlight.scan,
	},
];

/** Sugar so each rule reads as two phases rather than two enum keys. */
function phase(levels: {
	discovery: ReadinessRule["needLevel"][ProjectPhase];
	development: ReadinessRule["needLevel"][ProjectPhase];
}): ReadinessRule["needLevel"] {
	return {
		DISCOVERY_PLANNING: levels.discovery,
		DEVELOPMENT_EXECUTION: levels.development,
	};
}

export const READINESS_RULES_BY_KEY: ReadonlyMap<string, ReadinessRule> =
	new Map(READINESS_RULES.map((rule) => [rule.key, rule]));
