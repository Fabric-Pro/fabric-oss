/**
 * Code Validation Package
 *
 * Provides validation for TypeScript/JSX syntax and Tailwind CSS classes.
 * Used by the frames system to validate code before saving.
 */

export type {
	FrameCodeValidationResult,
	SyntaxValidationResult,
	TailwindValidationResult,
	TailwindValidationWarning,
	ValidationSeverity,
} from "./types/validation";
export { validateFrameCode } from "./validators/frame";
export { validateTailwindClasses } from "./validators/tailwind";
export { validateTypeScriptSyntax } from "./validators/typescript";
