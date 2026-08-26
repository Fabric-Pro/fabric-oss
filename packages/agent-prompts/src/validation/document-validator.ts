/**
 * Document Validator
 *
 * Validates document structure, formatting, content quality, and RAG usage.
 */

import type { DocumentType } from "@repo/agent-types";
import { getDocumentPrompt } from "../documents";
import { checkFormatting, type FormattingError } from "./formatting-checker";
import {
	hasRequiredSections,
	parseSections,
	validateHeadingHierarchy,
} from "./markdown-parser";

export interface ValidationError {
	type: "structure" | "formatting" | "content" | "rag_usage";
	severity: "error" | "warning";
	message: string;
	location?: string; // Section name or line number
	suggestion?: string;
}

export interface ValidationWarning {
	type: "structure" | "formatting" | "content" | "rag_usage";
	message: string;
	location?: string;
	suggestion?: string;
}

export interface ValidationResult {
	isValid: boolean;
	errors: ValidationError[];
	warnings: ValidationWarning[];
	score: number; // 0-100 quality score
	summary: {
		structureScore: number;
		formattingScore: number;
		contentScore: number;
		ragUsageScore: number;
	};
}

/**
 * Validate a document
 *
 * @param document - Document content to validate
 * @param documentType - Type of document
 * @param expectedSections - Optional list of expected section names
 * @param ragContexts - Optional RAG contexts for usage validation
 * @param originalDocument - Optional original document for content preservation validation
 * @returns Validation result with errors, warnings, and quality score
 */
export function validateDocument(
	document: string,
	documentType: DocumentType,
	expectedSections?: string[],
	ragContexts?: string[],
	originalDocument?: string,
): ValidationResult {
	const errors: ValidationError[] = [];
	const warnings: ValidationWarning[] = [];

	// 1. Structure validation
	const structureResult = validateStructure(
		document,
		documentType,
		expectedSections,
	);
	errors.push(...structureResult.errors);
	warnings.push(...structureResult.warnings);

	// 2. Formatting validation
	const formattingResult = checkFormatting(document);
	errors.push(
		...formattingResult.errors.map((e) => ({
			type: "formatting" as const,
			severity: e.severity,
			message: e.message,
			location: e.line?.toString(),
			suggestion: e.suggestion,
		})),
	);
	warnings.push(
		...formattingResult.warnings.map((e) => ({
			type: "formatting" as const,
			message: e.message,
			location: e.line?.toString(),
			suggestion: e.suggestion,
		})),
	);

	// 3. Content validation
	const contentResult = validateContent(document);
	warnings.push(...contentResult.warnings);

	// 3.5. Content preservation validation (if original document provided)
	if (originalDocument && originalDocument.trim().length > 0) {
		const preservationResult = validateContentPreservation(
			document,
			originalDocument,
		);
		warnings.push(...preservationResult.warnings);
		// Content preservation issues reduce content score
		if (preservationResult.warnings.length > 0) {
			contentResult.warnings.push(...preservationResult.warnings);
		}
	}

	// 4. RAG usage validation (if contexts provided)
	let ragUsageResult: { warnings: ValidationWarning[]; score: number } = {
		warnings: [],
		score: 100,
	};
	if (ragContexts && ragContexts.length > 0) {
		ragUsageResult = validateRagUsage(document, ragContexts);
		warnings.push(...ragUsageResult.warnings);
	}

	// Calculate quality scores
	const structureScore = calculateStructureScore(
		structureResult,
		documentType,
	);
	const formattingScore = calculateFormattingScore(formattingResult);
	const contentScore = calculateContentScore(contentResult, document);
	const ragUsageScore = ragUsageResult.score;

	// Overall score (weighted average)
	const overallScore = Math.round(
		structureScore * 0.3 +
			formattingScore * 0.3 +
			contentScore * 0.25 +
			ragUsageScore * 0.15,
	);

	return {
		isValid: errors.length === 0,
		errors,
		warnings,
		score: overallScore,
		summary: {
			structureScore,
			formattingScore,
			contentScore,
			ragUsageScore,
		},
	};
}

/**
 * Validate document structure
 */
function validateStructure(
	document: string,
	documentType: DocumentType,
	expectedSections?: string[],
): {
	errors: ValidationError[];
	warnings: ValidationWarning[];
} {
	const errors: ValidationError[] = [];
	const warnings: ValidationWarning[] = [];

	// Get required sections from document type config
	const docConfig = getDocumentPrompt(documentType);
	const requiredSections =
		expectedSections ||
		docConfig.sections.filter((s) => s.required).map((s) => s.name);

	// Check for required sections
	if (requiredSections.length > 0) {
		const sectionCheck = hasRequiredSections(document, requiredSections);
		for (const missing of sectionCheck.missing) {
			errors.push({
				type: "structure",
				severity: "error",
				message: `Missing required section: ${missing}`,
				suggestion: `Add a section with heading "## ${missing}"`,
			});
		}
	}

	// Validate heading hierarchy
	const hierarchyCheck = validateHeadingHierarchy(document);
	for (const error of hierarchyCheck.errors) {
		errors.push({
			type: "structure",
			severity: "error",
			message: error.message,
			location: error.line.toString(),
			suggestion: "Fix heading hierarchy (h2 -> h3 -> h4)",
		});
	}

	// Check for empty sections
	const sections = parseSections(document);
	for (const section of sections) {
		const contentLength = section.content
			.replace(/^#+\s+/gm, "")
			.trim().length;
		if (contentLength < 50) {
			warnings.push({
				type: "structure",
				message: `Section "${section.name}" has very little content (${contentLength} chars)`,
				location: section.name,
				suggestion: "Add more content to this section",
			});
		}
	}

	return { errors, warnings };
}

/**
 * Validate content quality
 */
function validateContent(document: string): {
	warnings: ValidationWarning[];
} {
	const warnings: ValidationWarning[] = [];
	const sections = parseSections(document);

	// Check minimum content length per section
	for (const section of sections) {
		const content = section.content.replace(/^#+\s+/gm, "").trim();
		const wordCount = content
			.split(/\s+/)
			.filter((w) => w.length > 0).length;

		if (wordCount < 20) {
			warnings.push({
				type: "content",
				message: `Section "${section.name}" is too short (${wordCount} words, minimum 20 recommended)`,
				location: section.name,
				suggestion: "Expand this section with more details",
			});
		}
	}

	// Check for placeholder text
	const placeholderPatterns = [
		/\[TODO:.*?\]/gi,
		/\[PLACEHOLDER:.*?\]/gi,
		/\[TBD\]/gi,
		/\.\.\./g,
	];

	for (const pattern of placeholderPatterns) {
		const matches = document.match(pattern);
		if (matches && matches.length > 0) {
			warnings.push({
				type: "content",
				message: `Found ${matches.length} placeholder(s) in document`,
				suggestion: "Replace placeholders with actual content",
			});
		}
	}

	return { warnings };
}

/**
 * Validate RAG context usage
 */
function validateRagUsage(
	document: string,
	ragContexts: string[],
): {
	warnings: ValidationWarning[];
	score: number;
} {
	const warnings: ValidationWarning[] = [];
	let score = 100;

	// Check for context references
	const referencePatterns = [
		/Reference\s+\[\d+\]/gi,
		/According to Reference/gi,
		/As noted in.*Reference/gi,
		/Reference \d+/gi,
	];

	const foundReferences = new Set<number>();
	for (const pattern of referencePatterns) {
		const matches = document.match(pattern);
		if (matches) {
			for (const match of matches) {
				const numMatch = match.match(/\d+/);
				if (numMatch) {
					foundReferences.add(Number.parseInt(numMatch[0], 10));
				}
			}
		}
	}

	// Check if enough contexts are referenced
	const minReferences = Math.min(3, ragContexts.length);
	if (foundReferences.size < minReferences) {
		const missing = minReferences - foundReferences.size;
		warnings.push({
			type: "rag_usage",
			message: `Only ${foundReferences.size} context(s) referenced, should reference at least ${minReferences}`,
			suggestion: `Reference more contexts using "According to Reference [N]" format`,
		});
		score -= missing * 15; // Deduct 15 points per missing reference
	}

	// Check for context-specific terminology
	// Extract key terms from contexts (simple approach: words in ALL CAPS or quoted)
	const contextTerms = new Set<string>();
	for (const context of ragContexts) {
		const capsWords = context.match(/\b[A-Z][A-Z0-9_]+\b/g);
		const quotedTerms = context.match(/"([^"]+)"/g);
		if (capsWords) {
			capsWords.forEach((w) => {
				contextTerms.add(w);
			});
		}
		if (quotedTerms) {
			quotedTerms.forEach((q) => {
				contextTerms.add(q.replace(/"/g, ""));
			});
		}
	}

	// Check if document uses context terminology
	let foundTerms = 0;
	for (const term of contextTerms) {
		if (document.includes(term)) {
			foundTerms++;
		}
	}

	if (foundTerms === 0 && contextTerms.size > 0) {
		warnings.push({
			type: "rag_usage",
			message:
				"Document doesn't appear to use terminology from provided contexts",
			suggestion:
				"Use exact terminology, names, and specifications from the contexts",
		});
		score -= 20;
	}

	score = Math.max(0, score); // Ensure score doesn't go below 0

	return { warnings, score };
}

/**
 * Validate content preservation when editing existing documents
 * Checks for significant length reduction that might indicate content loss
 */
function validateContentPreservation(
	newDocument: string,
	originalDocument: string,
): {
	warnings: ValidationWarning[];
} {
	const warnings: ValidationWarning[] = [];

	// Check for significant length reduction (potential content loss)
	const originalLength = originalDocument.trim().length;
	const newLength = newDocument.trim().length;
	const lengthRatio = newLength / originalLength;

	if (lengthRatio < 0.8 && originalLength > 500) {
		// More than 20% reduction for documents over 500 chars
		warnings.push({
			type: "content",
			message: `Document length reduced by ${Math.round((1 - lengthRatio) * 100)}% (${originalLength} → ${newLength} chars)`,
			suggestion:
				"Ensure all original content is preserved when improving formatting",
		});
	}

	return { warnings };
}

/**
 * Calculate structure score (0-100)
 */
function calculateStructureScore(
	result: { errors: ValidationError[]; warnings: ValidationWarning[] },
	_documentType: DocumentType,
): number {
	let score = 100;

	// Deduct for errors
	score -= result.errors.length * 20;

	// Deduct for warnings
	score -= result.warnings.length * 5;

	return Math.max(0, Math.min(100, score));
}

/**
 * Calculate formatting score (0-100)
 */
function calculateFormattingScore(result: {
	errors: FormattingError[];
	warnings: FormattingError[];
}): number {
	let score = 100;

	// Deduct for errors
	score -= result.errors.length * 15;

	// Deduct for warnings
	score -= result.warnings.length * 3;

	return Math.max(0, Math.min(100, score));
}

/**
 * Calculate content score (0-100)
 */
function calculateContentScore(
	result: { warnings: ValidationWarning[] },
	document: string,
): number {
	let score = 100;

	// Deduct for warnings
	score -= result.warnings.length * 5;

	// Check document length (very short documents get penalty)
	const wordCount = document.split(/\s+/).filter((w) => w.length > 0).length;
	if (wordCount < 100) {
		score -= 20;
	} else if (wordCount < 200) {
		score -= 10;
	}

	return Math.max(0, Math.min(100, score));
}
