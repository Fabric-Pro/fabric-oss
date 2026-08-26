import {
	type DecisionStatus,
	DOMAIN_CONFIG,
	formatDecisionDateTime,
	formatDecisionDateTimeUtc,
	isDecisionDomain,
	STATUS_CONFIG,
} from "./constants";

export interface MarkdownDecision {
	identifier: string;
	title: string;
	status: DecisionStatus;
	domain?: string | null;
	decisionDate: string | Date;
	contextProblem?: string | null;
	decisionDrivers?: string | null;
	decision?: string | null;
	rationale?: string | null;
	alternativesConsidered?: string | null;
	consequences?: string | null;
	participantNames?: string[];
	participantsText?: string | null;
	vouchedByName?: string | null;
	vouchedAt?: string | Date | null;
}

/** Render one decision as a Nygard/MADR-style Markdown ADR (docs-as-code export). */
export function decisionToMarkdown(d: MarkdownDecision): string {
	const lines: string[] = [`# ${d.identifier}: ${d.title}`, ""];
	lines.push(`- **Status:** ${STATUS_CONFIG[d.status].label}`);
	if (isDecisionDomain(d.domain)) {
		lines.push(`- **Domain:** ${DOMAIN_CONFIG[d.domain].label}`);
	}
	lines.push(
		`- **Date:** ${formatDecisionDateTime(d.decisionDate)} (local) · ${formatDecisionDateTimeUtc(d.decisionDate)}`,
	);
	const participants = [
		...(d.participantNames ?? []),
		d.participantsText,
	].filter((p): p is string => Boolean(p?.trim()));
	if (participants.length > 0) {
		lines.push(`- **Participants:** ${participants.join(", ")}`);
	}
	if (d.vouchedAt || d.vouchedByName) {
		const on = d.vouchedAt
			? ` (${formatDecisionDateTime(d.vouchedAt)})`
			: "";
		lines.push(
			`- **Endorsed by:** ${d.vouchedByName ?? "a maintainer"}${on}`,
		);
	}

	const section = (label: string, value?: string | null) => {
		if (value?.trim()) {
			lines.push("", `## ${label}`, "", value.trim());
		}
	};
	section("Context and Problem Statement", d.contextProblem);
	section("Decision Drivers", d.decisionDrivers);
	section("Decision", d.decision);
	section("Rationale", d.rationale);
	section("Alternatives Considered", d.alternativesConsidered);
	section("Consequences", d.consequences);
	return lines.join("\n");
}

/** Render the whole log as a single Markdown document. */
export function decisionsToMarkdown(items: MarkdownDecision[]): string {
	return [
		"# Architecture Decision Log",
		"",
		...items.map(decisionToMarkdown),
	].join("\n\n---\n\n");
}

/** Slugify an identifier+title into an ADR filename, e.g. ADR-004-feature-flags.md */
export function decisionFilename(identifier: string, title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return `${identifier}${slug ? `-${slug}` : ""}.md`;
}

/** Trigger a client-side download of a markdown file. */
export function downloadMarkdown(filename: string, content: string): void {
	const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}
