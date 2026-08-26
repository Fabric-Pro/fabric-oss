/**
 * TypeScript/JSX Syntax Validator
 *
 * Validates TypeScript and JSX syntax using Babel parser.
 */

import { parse } from "@babel/parser";
import type {
	SyntaxError as CodeSyntaxError,
	SyntaxValidationResult,
} from "../types/validation";

/**
 * Validate TypeScript/JSX syntax
 *
 * Parses the code using Babel parser with TypeScript and JSX plugins.
 * Returns detailed error information if parsing fails.
 *
 * @param code - The code to validate
 * @returns SyntaxValidationResult with validity and error details
 */
export function validateTypeScriptSyntax(code: string): SyntaxValidationResult {
	try {
		parse(code, {
			sourceType: "module",
			plugins: [
				"jsx",
				"typescript",
				"decorators-legacy",
				"classProperties",
				"asyncGenerators",
				"dynamicImport",
				"objectRestSpread",
				"optionalChaining",
				"nullishCoalescingOperator",
			],
		});

		return { valid: true, errors: [] };
	} catch (error: any) {
		const errors: CodeSyntaxError[] = [];

		// Babel errors have loc information
		if (error.loc) {
			errors.push({
				message: error.message.replace(/\(.*?\)/, "").trim(),
				line: error.loc.line,
				column: error.loc.column,
				severity: "error",
			});
		} else {
			// Fallback for other errors
			errors.push({
				message: error.message || "Unknown syntax error",
				line: 1,
				column: 0,
				severity: "error",
			});
		}

		return { valid: false, errors };
	}
}
