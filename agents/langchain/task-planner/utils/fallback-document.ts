/**
 * Fallback Document Generator
 *
 * Generates a fallback document when the LLM fails to use the tool.
 */

import type { TaskPlannerStateType } from "../state";

/**
 * Generate a fallback document from state
 *
 * Used when the LLM doesn't properly call the write_task_plan tool.
 *
 * @param state - Current task planner state
 * @returns Generated markdown document
 */
export function generateFallbackDocument(state: TaskPlannerStateType): string {
	const totalEstimate = state.decomposedTasks.reduce(
		(sum, t) => sum + t.estimate,
		0,
	);
	const highRiskTasks = state.decomposedTasks.filter((t) => t.riskScore > 70);

	return `# Task Plan: ${state.projectName}

## Executive Summary
- **Total Tasks:** ${state.decomposedTasks.length}
- **Total Estimate:** ${totalEstimate} hours
- **Overall Risk Score:** ${state.riskAnalysis?.overallScore || 0}/100
- **High Risk Tasks:** ${highRiskTasks.length}
- **Execution Phases:** ${state.executionPlan?.phases.length || 0}
- **Recommended Team Size:** ${state.executionPlan?.recommendedTeamSize || 1}

## Task Breakdown

${state.decomposedTasks
	.map(
		(t) => `### ${t.id}: ${t.title}
- **Type:** ${t.type}
- **Estimate:** ${t.estimate} hours
- **Complexity:** ${t.complexity}
- **Risk Score:** ${t.riskScore}/100
- **Parallelizable:** ${t.parallelizable ? "Yes" : "No"}

${t.description}

**Acceptance Criteria:**
${t.acceptanceCriteria?.map((c) => `- [ ] ${c}`).join("\n") || "- [ ] TBD"}

**Technical Approach:**
${t.technicalApproach?.map((s, i) => `${i + 1}. ${s}`).join("\n") || "1. TBD"}

**Files to Modify:**
${t.filesToModify?.map((f) => `- \`${f}\``).join("\n") || "- TBD"}

---
`,
	)
	.join("\n")}

## Risk Assessment

**Overall Score:** ${state.riskAnalysis?.overallScore || 0}/100

${
	state.riskAnalysis?.factors
		.map(
			(f) => `### ${f.id}: ${f.description}
- **Category:** ${f.category}
- **Severity:** ${f.severity}
- **Probability:** ${(f.probability * 100).toFixed(0)}%
- **Impact:** ${f.impact}/100
`,
		)
		.join("\n") || "No risks identified"
}

## Execution Plan

${
	state.executionPlan?.phases
		.map(
			(p) => `### ${p.name}
- **Duration:** ${p.duration} hours
- **Tasks:** ${p.tasks.join(", ")}
`,
		)
		.join("\n") || "Execution plan not generated"
}

## Recommendations

${state.riskAnalysis?.recommendations.map((r) => `- ${r}`).join("\n") || "No recommendations"}
`;
}
