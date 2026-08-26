/**
 * Frame Code Validator
 *
 * Combines TypeScript/JSX and Tailwind validation for frame content.
 */

import type {
	FrameCodeValidationResult,
	ValidationIssue,
} from "../types/validation";
import { validateTailwindClasses } from "./tailwind";
import { validateTypeScriptSyntax } from "./typescript";

/**
 * Validate frame code
 *
 * Performs both TypeScript/JSX syntax validation and Tailwind class validation.
 * Returns a combined result with all issues and a "canSave" flag.
 *
 * @param code - The frame code to validate
 * @returns FrameCodeValidationResult
 */
export function validateFrameCode(code: string): FrameCodeValidationResult {
	// Run both validators
	const syntaxResult = validateTypeScriptSyntax(code);
	const tailwindResult = validateTailwindClasses(code);

	// Combine all issues
	const allIssues: ValidationIssue[] = [];

	// Add syntax errors
	for (const error of syntaxResult.errors) {
		allIssues.push({
			type: "syntax",
			severity: error.severity,
			message: error.message,
			line: error.line,
			column: error.column,
		});
	}

	// Add Tailwind warnings
	for (const warning of tailwindResult.warnings) {
		allIssues.push({
			type: "tailwind",
			severity: "warning",
			message: warning.message,
			line: warning.line,
			column: warning.column,
			details: `Class: ${warning.className}`,
		});
	}

	// Sort by line number
	allIssues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

	// Determine if can save
	// Can save if no syntax errors (Tailwind warnings don't block save)
	const canSave = syntaxResult.valid;

	return {
		valid: syntaxResult.valid && tailwindResult.valid,
		canSave,
		syntax: syntaxResult,
		tailwind: tailwindResult,
		allIssues,
	};
}
