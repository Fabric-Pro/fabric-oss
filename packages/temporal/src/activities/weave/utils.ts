/**
 * Utility Activities
 *
 * Activities for non-deterministic operations like UUID generation and dates.
 */

import { randomUUID } from "node:crypto";

export async function generateUUIDActivity(): Promise<string> {
	return randomUUID();
}

export async function getCurrentDateActivity(): Promise<Date> {
	return new Date();
}

export interface AssessComplexityInput {
	userMessage: string;
	projectName: string;
	techStack?: string;
}

export async function assessComplexityActivity(
	input: AssessComplexityInput,
): Promise<"low" | "medium" | "high" | "complex"> {
	// In production, this would call an AI model
	// For now, use simple heuristic based on message length
	const msg = input.userMessage.toLowerCase();

	if (
		msg.includes("architecture") ||
		msg.includes("refactor") ||
		msg.includes("migration") ||
		msg.includes("redesign")
	) {
		return "complex";
	}

	if (
		msg.includes("feature") ||
		msg.includes("implement") ||
		msg.includes("create")
	) {
		return input.userMessage.length > 200 ? "high" : "medium";
	}

	if (msg.includes("fix") || msg.includes("bug") || msg.includes("update")) {
		return "low";
	}

	return "medium";
}
