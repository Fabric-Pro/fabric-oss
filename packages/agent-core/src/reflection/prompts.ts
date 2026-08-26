/**
 * Reflection Node Prompts
 *
 * System prompts for the reflection evaluation process.
 */

import type { QualityDimension, ReflectionConfig } from "./types";

/**
 * Get the system prompt for reflection evaluation
 */
export function getReflectionSystemPrompt(config: ReflectionConfig): string {
	const dimensions = config.dimensions || [
		"accuracy",
		"completeness",
		"relevance",
		"coherence",
	];

	return `You are a quality evaluation expert. Your task is to evaluate an AI-generated output against specific quality dimensions.

## Evaluation Dimensions

${dimensions.map((d) => getDimensionDescription(d)).join("\n\n")}

${config.customCriteria ? `## Custom Criteria\n${config.customCriteria}\n` : ""}

## Instructions

1. Evaluate the output against each dimension
2. Provide a score from 0-100 for each dimension
3. Identify specific issues and suggest improvements
4. Be constructive but thorough in your feedback

## Response Format

You MUST respond with a valid JSON object in this exact format:
{
  "evaluations": [
    {
      "dimension": "accuracy",
      "score": 85,
      "feedback": "The output is mostly accurate...",
      "suggestions": ["Consider adding...", "Verify the claim about..."]
    }
  ],
  "overallScore": 82,
  "issues": ["Issue 1", "Issue 2"],
  "improvements": ["Improvement 1", "Improvement 2"],
  "passed": true
}`;
}

/**
 * Get description for a quality dimension
 */
function getDimensionDescription(dimension: QualityDimension): string {
	const descriptions: Record<QualityDimension, string> = {
		accuracy: `### Accuracy (0-100)
- Is the information factually correct?
- Are there any errors or misstatements?
- Are claims properly supported?`,

		completeness: `### Completeness (0-100)
- Does the output address all aspects of the input?
- Are there any missing elements?
- Is the response thorough enough?`,

		relevance: `### Relevance (0-100)
- Is the output directly relevant to the input?
- Is there unnecessary or off-topic content?
- Does it stay focused on the task?`,

		coherence: `### Coherence (0-100)
- Is the output well-organized and logical?
- Does it flow naturally?
- Is it easy to understand?`,

		safety: `### Safety (0-100)
- Is the content appropriate and safe?
- Are there any harmful or biased statements?
- Does it follow ethical guidelines?`,

		format: `### Format (0-100)
- Does the output match the expected format?
- Is it properly structured?
- Are there any formatting issues?`,

		custom: `### Custom Criteria (0-100)
- Evaluate based on the custom criteria provided`,
	};

	return descriptions[dimension];
}

/**
 * Get the user prompt for reflection evaluation
 */
export function getReflectionUserPrompt(
	output: string,
	input: string,
	context?: string,
	expectedFormat?: string,
): string {
	return `## Original Input
${input}

${context ? `## Context\n${context}\n` : ""}
${expectedFormat ? `## Expected Format\n${expectedFormat}\n` : ""}
## Output to Evaluate
${output}

Please evaluate this output and provide your assessment in the JSON format specified.`;
}

/**
 * Get the correction prompt for improving output
 */
export function getCorrectionPrompt(
	output: string,
	input: string,
	issues: string[],
	improvements: string[],
): string {
	return `You are tasked with improving an AI-generated output based on feedback.

## Original Input
${input}

## Current Output
${output}

## Issues Identified
${issues.map((i, idx) => `${idx + 1}. ${i}`).join("\n")}

## Suggested Improvements
${improvements.map((i, idx) => `${idx + 1}. ${i}`).join("\n")}

## Instructions
Please provide an improved version of the output that addresses the issues and incorporates the improvements.
Maintain the same general structure and format, but fix the identified problems.

Respond with ONLY the improved output, no explanations.`;
}
