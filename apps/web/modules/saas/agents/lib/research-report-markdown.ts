import type { WorkflowTemplateState } from "../hooks/useWorkflowTemplateStream";

/**
 * A research result as one markdown report: what the result viewer copies,
 * downloads and saves as an artifact, and what the agent runtime saves as a
 * research run's answer.
 */
export function researchReportMarkdown(
	result: NonNullable<WorkflowTemplateState["result"]>,
) {
	if (result.structuredReport) {
		return [
			`# ${result.structuredReport.title}`,
			"",
			"## Executive Summary",
			result.structuredReport.executiveSummary,
			"",
			...result.structuredReport.sections.flatMap((section) => [
				`## ${section.heading}`,
				section.content,
				"",
			]),
			"## Methodology",
			result.structuredReport.methodology,
			"",
			"## Sources",
			...result.structuredReport.citedSources.map(
				(source) => `- [${source.sourceType}] ${source.source}`,
			),
		].join("\n");
	}

	return [
		"# Research Results",
		"",
		result.summary ? `## Summary\n${result.summary}\n` : "",
		result.text ? `## Full Report\n${result.text}\n` : "",
		result.keyFindings.length > 0
			? `## Key Findings\n${result.keyFindings
					.map(
						(finding) =>
							`### ${finding.theme} (${finding.confidence}% confidence)\n${finding.findings.map((item) => `- ${item}`).join("\n")}`,
					)
					.join("\n\n")}\n`
			: "",
		result.sources.length > 0
			? `## Sources\n${result.sources.map((source) => `- ${source}`).join("\n")}`
			: "",
	].join("\n");
}
