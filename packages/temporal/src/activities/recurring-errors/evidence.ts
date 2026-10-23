/**
 * What a recurring-error proposal says about its evidence. PURE.
 *
 * Every sample message is untrusted log content. It reaches storage, the
 * prompt and the review inbox only after the same two steps the bug-analysis
 * log context uses: the property policy, then redaction. Component names and
 * exception types come off the same log rows, so they are redacted too.
 */
import {
	applyPropertyPolicy,
	type RawErrorGroup,
} from "@repo/ai/lib/log-context";
import { redactLogEntries, redactLogText } from "@repo/utils/log-redaction";
import type { FingerprintedErrorGroup } from "./fingerprint";
import { normalizeErrorMessage } from "./fingerprint";

/** Per-sample cap once redacted, so the stored excerpt stays small. */
const MAX_EXCERPT_CHARS = 500;
const MAX_TITLE_CHARS = 200;

export interface RedactedErrorGroup {
	fingerprint: string;
	kind: RawErrorGroup["kind"];
	/** Redacted, normalized headline of the group. */
	title: string;
	occurrences: number;
	firstSeen: string;
	lastSeen: string;
	affectedUsers: number;
	components: string[];
	excerpts: string[];
	exceptionType?: string;
}

function redactShort(value: string, cap: number): string {
	return redactLogText(value.slice(0, cap)).text;
}

export function redactErrorGroup(
	group: FingerprintedErrorGroup,
): RedactedErrorGroup {
	const { entries } = redactLogEntries(
		applyPropertyPolicy(
			group.sampleMessages.map((message) => ({ message })),
		),
	);
	const excerpts = entries.map((entry) =>
		entry.message.slice(0, MAX_EXCERPT_CHARS),
	);
	const exceptionType = group.exceptionType
		? redactShort(group.exceptionType, MAX_TITLE_CHARS)
		: undefined;
	// The headline is built from the redacted excerpt, never the raw key: an
	// exception group's key is the platform's problem id, which can embed a
	// value redaction would have removed from the message.
	const headline = normalizeErrorMessage(excerpts[0] ?? "");
	return {
		fingerprint: group.fingerprint,
		kind: group.kind,
		title: (
			[exceptionType, headline].filter(Boolean).join(": ") ||
			"Recurring application error"
		).slice(0, MAX_TITLE_CHARS),
		occurrences: group.occurrences,
		firstSeen: group.firstSeen,
		lastSeen: group.lastSeen,
		affectedUsers: group.affectedUsers,
		components: group.components.map((name) => redactShort(name, 120)),
		excerpts,
		exceptionType,
	};
}

/** A cluster of open bug reports the scan found to be the same problem. */
export interface IncidentCluster {
	fingerprint: string;
	stories: Array<{ id: string; identifier: string; title: string }>;
}

/**
 * Indent a sample four spaces. The evidence is shown as written in the inbox
 * and in bug comments, where a code fence would appear as literal backticks,
 * and an indented block is still a code block wherever Markdown is rendered.
 */
function indentedBlock(text: string): string {
	return text
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
}

/**
 * The evidence section of a log proposal: the proposal's stored transcript
 * (the inbox evidence and the drafting step's additional context), the note
 * on an open bug, and the deterministic description when the AI draft is
 * unavailable.
 */
export function renderLogEvidence(
	group: RedactedErrorGroup,
	windowHours: number,
	detectedAt: string,
): string {
	const lines = [
		"Detected automatically by Fabric's recurring-error scan.",
		"",
		`- Occurrences: ${group.occurrences} in the last ${windowHours} hours`,
		`- Components: ${group.components.length > 0 ? group.components.join(", ") : "not reported"}`,
		`- Affected users: ${group.affectedUsers > 0 ? group.affectedUsers : "not reported"}`,
		`- First seen: ${group.firstSeen}`,
		`- Last seen: ${group.lastSeen}`,
		`- Detected: ${detectedAt}`,
	];
	if (group.exceptionType) {
		lines.push(`- Exception type: ${group.exceptionType}`);
	}
	if (group.excerpts.length > 0) {
		lines.push("", "Sample messages (redacted):");
		for (const excerpt of group.excerpts) {
			lines.push("", indentedBlock(excerpt));
		}
	}
	return lines.join("\n");
}

export function renderIncidentEvidence(
	cluster: IncidentCluster,
	detectedAt: string,
): string {
	return [
		"Detected automatically by Fabric's recurring-error scan: these open bug reports were judged to describe the same problem.",
		"",
		...cluster.stories.map(
			(story) => `- ${story.identifier}: ${story.title}`,
		),
		"",
		`- Reports: ${cluster.stories.length}`,
		`- Detected: ${detectedAt}`,
	].join("\n");
}

export type BugPriority = "P0_CRITICAL" | "P1_HIGH" | "P2_MEDIUM" | "P3_LOW";

export interface BugReportDraft {
	title: string;
	description: string;
	priority: BugPriority;
}

/**
 * The change proposal for one recurring problem, in the shape every inbox
 * producer stores. One BUG create per proposal, so distinct problems are
 * reviewed (and approved or rejected) independently.
 *
 * `kindOverride: "BUG"` is what keeps it a bug: the approve path honours it
 * and skips the kind classifier, exactly as when a reviewer picks the kind by
 * hand. Without it the classifier could re-file a monitor's error report as a
 * feature.
 */
export function buildRecurringBugProposal(input: {
	draft: BugReportDraft;
	reasoning: string;
	sourceContext: "application_logs" | "bug_reports";
	fingerprint: string;
}) {
	return {
		summary: input.draft.title,
		contextSummary: input.reasoning,
		changes: [
			{
				type: "bug" as const,
				action: "create" as const,
				title: { to: input.draft.title },
				description: { to: input.draft.description },
				priority: { to: input.draft.priority },
				reasoning: input.reasoning,
				sourceContext: input.sourceContext,
				kindOverride: "BUG" as const,
				sourceChangeKey: `recurring-error:${input.fingerprint}`,
			},
		],
	};
}

/** A one-line, reviewer-facing account of why the scan proposed this. */
export function logReasoning(
	group: RedactedErrorGroup,
	windowHours: number,
): string {
	return `This error recurred ${group.occurrences} times in the last ${windowHours} hours${
		group.components.length > 0 ? ` in ${group.components.join(", ")}` : ""
	}.`;
}

export function incidentReasoning(cluster: IncidentCluster): string {
	return `${cluster.stories.length} open bug reports (${cluster.stories
		.map((story) => story.identifier)
		.join(", ")}) describe the same problem.`;
}

/** Deterministic report used when the AI draft is unavailable. */
export function fallbackLogDraft(
	group: RedactedErrorGroup,
	evidence: string,
): BugReportDraft {
	return {
		title: `Recurring error: ${group.title}`.slice(0, 120),
		description: evidence,
		priority: group.occurrences >= 100 ? "P1_HIGH" : "P2_MEDIUM",
	};
}

export function fallbackIncidentDraft(
	cluster: IncidentCluster,
	evidence: string,
): BugReportDraft {
	const lead = cluster.stories[0]?.title ?? "related bug reports";
	return {
		title: `Consolidate ${cluster.stories.length} reports: ${lead}`.slice(
			0,
			120,
		),
		description: evidence,
		priority: "P2_MEDIUM",
	};
}
