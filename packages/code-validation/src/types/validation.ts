/**
 * Validation result types for code validation
 */

export type ValidationSeverity = "error" | "warning" | "info";

export interface SyntaxValidationResult {
	valid: boolean;
	errors: SyntaxError[];
}

export interface SyntaxError {
	message: string;
	line: number;
	column: number;
	severity: "error" | "warning";
}

export interface TailwindValidationWarning {
	message: string;
	className: string;
	line?: number;
	column?: number;
}

export interface TailwindValidationResult {
	valid: boolean;
	warnings: TailwindValidationWarning[];
}

export interface FrameCodeValidationResult {
	valid: boolean;
	canSave: boolean;
	syntax: SyntaxValidationResult;
	tailwind: TailwindValidationResult;
	allIssues: ValidationIssue[];
}

export interface ValidationIssue {
	type: "syntax" | "tailwind";
	severity: ValidationSeverity;
	message: string;
	line?: number;
	column?: number;
	details?: string;
}
