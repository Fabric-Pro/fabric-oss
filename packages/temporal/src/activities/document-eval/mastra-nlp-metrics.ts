/**
 * NLP-based evaluation metrics built with Mastra scorers.
 *
 * EVAL_VERSION 3 Improvements:
 * - Section content depth validation (not just existence)
 * - Stricter word count requirements per document type
 * - Semantic keyword matching with synonyms
 * - Fixed similarity scoring (no auto-100 without golden reference)
 * - Empty section detection
 * - Duplicate section detection
 * - Content depth validation
 */

import { createScorer } from "@mastra/core/evals";
import {
	findSectionGroup,
	getRequiredGroupsForDocType,
	getSectionNames,
	SECTION_SEMANTIC_GROUPS,
	sectionMatchesGroup,
} from "@repo/agent-prompts";
import { z } from "zod";

const evalInputSchema = z.object({
	documentType: z.string(),
	requiredSections: z.array(z.string()).optional(),
	keyPhrases: z.array(z.string()).optional(),
	goldenContent: z.string().optional(),
});

const evalOutputSchema = z.string();

type EvalInput = z.infer<typeof evalInputSchema>;

export interface NLPMetricResult {
	name: string;
	score: number;
	details: {
		found: string[];
		missing: string[];
		extras?: string[];
	};
	feedback: string;
}

export interface NLPEvalResult {
	completeness: NLPMetricResult;
	similarity: NLPMetricResult;
	keywords: NLPMetricResult;
	structure: NLPMetricResult;
	overallScore: number;
	executionTimeMs: number;
}

const MAX_WORDS_FOR_SIMILARITY = 4000;

// ============================================================================
// PHASE 1.1: Enhanced Completeness with Content Depth
// ============================================================================

interface SectionValidation {
	name: string;
	found: boolean;
	hasContent: boolean;
	wordCount: number;
	meetsMinimum: boolean;
}

// Minimum word counts per section type
// PRD FORMAT (PM Standard v2) sections included
const SECTION_MINIMUM_WORDS: Record<string, number> = {
	// PRD FORMAT sections
	benefit_hypothesis: 30, // Single clear statement
	summary: 100, // Overview: Problem, Why now, Goal, Non-goals
	goals: 100, // Success Metrics table + measurement approach
	requirements: 150, // Must Have, Nice to Have, Non-Functional
	users: 80, // Users/Personas: Primary, Secondary, Internal
	scope: 80, // In Scope, Out of Scope
	key_flows: 100, // Happy path, Edge cases, Failure/recovery
	risks: 80, // Dependencies and Risks with mitigation
	stakeholders: 50, // All roles with names
	stakeholders_prd: 50, // PM format stakeholders
	work_breakdown: 80, // Epics, Features, Stories, Spikes
	release_notes: 30, // What shipped + who it helps
	// Technical document sections
	technical: 250,
	data: 150,
	api: 200,
	security: 150,
	testing: 150,
	timeline: 100,
	acceptance: 100,
	metadata: 30,
	glossary: 50,
	vision: 100,
	performance: 150,
	operations: 150,
	migration: 150,
	compliance: 150,
	quality_attributes: 150,
	cross_cutting: 150,
	configuration: 100,
	governance: 100,
	deprecation: 100,
};

function extractSectionContent(
	documentContent: string,
	sectionName: string,
): string | null {
	// Find the section by looking for its heading
	const lines = documentContent.split("\n");
	let sectionStart = -1;
	let sectionEnd = -1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^(#{1,6})\s+(.+)$/);

		if (match) {
			const level = match[1].length;
			const title = match[2].trim();

			// Check if this is our section (h2 level)
			if (level === 2) {
				const normalizedTitle = title.toLowerCase();
				const normalizedSection = sectionName.toLowerCase();

				// Check if it matches the section name or is in the section group
				const matchesByName =
					normalizedTitle.includes(normalizedSection) ||
					normalizedSection.includes(normalizedTitle);
				const matchesByGroup =
					isGroupName(sectionName) &&
					sectionMatchesGroup(title, sectionName);

				if (matchesByName || matchesByGroup) {
					if (sectionStart === -1) {
						sectionStart = i + 1;
					}
				} else if (sectionStart !== -1 && sectionEnd === -1) {
					// Found another h2, end of our section
					sectionEnd = i;
					break;
				}
			}
		}
	}

	if (sectionStart === -1) {
		return null;
	}
	if (sectionEnd === -1) {
		sectionEnd = lines.length;
	}

	const sectionLines = lines.slice(sectionStart, sectionEnd);
	return sectionLines.join("\n").trim();
}

function countWords(text: string | null): number {
	if (!text) {
		return 0;
	}
	return text.split(/\s+/).filter(Boolean).length;
}

function validateSectionContent(
	documentContent: string,
	sectionName: string,
): SectionValidation {
	const sectionContent = extractSectionContent(documentContent, sectionName);
	const wordCount = countWords(sectionContent);
	const minimum = SECTION_MINIMUM_WORDS[sectionName] ?? 50;

	return {
		name: sectionName,
		found: sectionContent !== null,
		hasContent: wordCount > 20, // At least 20 words = non-trivial
		wordCount,
		meetsMinimum: wordCount >= minimum,
	};
}

function calculateCompletenessScoreWithDepth(
	validations: SectionValidation[],
): number {
	const totalSections = validations.length;
	if (totalSections === 0) {
		return 0; // No requirements = 0, not 100
	}

	let score = 0;
	for (const v of validations) {
		if (!v.found) {
			continue; // 0 points
		}
		if (!v.hasContent) {
			score += 25; // Found but empty = 25%
		} else if (!v.meetsMinimum) {
			score += 60; // Has content but short = 60%
		} else {
			score += 100; // Full credit = 100%
		}
	}

	return Math.round(score / totalSections);
}

// ============================================================================
// PHASE 1.2: Enhanced Structure Scoring
// ============================================================================

const STRUCTURE_RULES: Record<
	string,
	{ minWords: number; minSections: number }
> = {
	prd: { minWords: 1000, minSections: 5 },
	architecture: { minWords: 1200, minSections: 5 },
	technical_spec: { minWords: 1500, minSections: 6 },
	api_spec: { minWords: 800, minSections: 3 },
	user_story: { minWords: 500, minSections: 2 },
	proposal: { minWords: 600, minSections: 3 },
	general: { minWords: 300, minSections: 2 },
};

function detectEmptySections(content: string): string[] {
	const sections = content.split(/(?=^##\s+)/m);
	const empty: string[] = [];

	for (const section of sections) {
		const titleMatch = section.match(/^##\s+(.+)$/m);
		if (!titleMatch) {
			continue;
		}

		const title = titleMatch[1];
		const contentAfterTitle = section.slice(titleMatch[0].length).trim();
		const wordCount = contentAfterTitle.split(/\s+/).filter(Boolean).length;

		if (wordCount < 20) {
			empty.push(title);
		}
	}

	return empty;
}

function detectDuplicateSections(content: string): string[] {
	const sections = content.match(/^##\s+(.+)$/gm) || [];
	const sectionTitles = sections.map((s) =>
		s
			.replace(/^##\s+/, "")
			.trim()
			.toLowerCase(),
	);
	const seen = new Set<string>();
	const duplicates = new Set<string>();

	for (const title of sectionTitles) {
		if (seen.has(title)) {
			duplicates.add(title);
		}
		seen.add(title);
	}

	return Array.from(duplicates);
}

function validateStructureWithRules(
	content: string,
	docType: string,
): { score: number; issues: string[] } {
	const rules =
		STRUCTURE_RULES[docType.toLowerCase()] ?? STRUCTURE_RULES.general;
	const lines = content.split("\n");
	const issues: string[] = [];
	let score = 100;

	// 1. Check document title (h1)
	const hasTitle = lines.some((line) => /^#\s+.+$/.test(line));
	if (!hasTitle) {
		issues.push("Missing document title (h1)");
		score -= 15; // Increased from 10
	}

	// 2. Check heading hierarchy
	let lastLevel = 0;
	let hierarchyViolations = 0;
	for (const line of lines) {
		const match = line.match(/^(#{1,6})\s+/);
		if (match) {
			const level = match[1].length;
			if (level > lastLevel + 1 && lastLevel > 0) {
				hierarchyViolations++;
			}
			lastLevel = level;
		}
	}
	if (hierarchyViolations > 0) {
		issues.push(`Heading hierarchy violations: ${hierarchyViolations}`);
		score -= Math.min(15, hierarchyViolations * 5);
	}

	// 3. Check word count against document type requirements
	const wordCount = content.split(/\s+/).filter(Boolean).length;
	if (wordCount < rules.minWords * 0.3) {
		issues.push(
			`Document is critically short (${wordCount}/${rules.minWords} words)`,
		);
		score -= 40; // Severe penalty
	} else if (wordCount < rules.minWords * 0.6) {
		issues.push(
			`Document is very short (${wordCount}/${rules.minWords} words)`,
		);
		score -= 25;
	} else if (wordCount < rules.minWords) {
		issues.push(
			`Document is below recommended length (${wordCount}/${rules.minWords} words)`,
		);
		score -= 10;
	}

	// 4. Check section count
	const sectionCount = (content.match(/^##\s+/gm) || []).length;
	if (sectionCount < rules.minSections * 0.5) {
		issues.push(
			`Too few sections (${sectionCount}/${rules.minSections} minimum)`,
		);
		score -= 20;
	} else if (sectionCount < rules.minSections) {
		issues.push(
			`Below recommended section count (${sectionCount}/${rules.minSections})`,
		);
		score -= 10;
	}

	// 5. Check for placeholders (stricter regex)
	const placeholderPatterns = [
		/\[TODO\]/gi,
		/\[TBD\]/gi,
		/\[PLACEHOLDER\]/gi,
		/\[INSERT\s+.+?\]/gi,
		/\[FILL\s+IN\]/gi,
		/\[ADD\s+.+?\]/gi,
		/Lorem ipsum/gi,
		/Example content here/gi,
		/\bTBD\b/g,
	];

	let totalPlaceholders = 0;
	for (const pattern of placeholderPatterns) {
		const matches = content.match(pattern);
		if (matches) {
			totalPlaceholders += matches.length;
		}
	}

	if (totalPlaceholders > 0) {
		issues.push(`Found ${totalPlaceholders} placeholder(s) in document`);
		score -= Math.min(30, totalPlaceholders * 8); // Increased penalty
	}

	// 6. Check for empty sections
	const emptySections = detectEmptySections(content);
	if (emptySections.length > 0) {
		issues.push(`Empty sections: ${emptySections.slice(0, 3).join(", ")}`);
		score -= emptySections.length * 10;
	}

	// 7. Check for duplicate sections
	const duplicateSections = detectDuplicateSections(content);
	if (duplicateSections.length > 0) {
		issues.push(`Duplicate sections: ${duplicateSections.join(", ")}`);
		score -= duplicateSections.length * 10;
	}

	return { score: Math.max(0, score), issues };
}

// ============================================================================
// PHASE 1.3: Enhanced Keyword Matching with Synonyms
// ============================================================================

const PHRASE_SYNONYMS: Record<string, string[]> = {
	"success metrics": [
		"kpis",
		"key performance indicators",
		"success criteria",
		"metrics",
	],
	"acceptance criteria": [
		"ac",
		"criteria",
		"definition of done",
		"done criteria",
	],
	"user persona": [
		"personas",
		"user profile",
		"target user",
		"user archetype",
	],
	"user story": ["stories", "use case", "scenario"],
	mvp: ["minimum viable product", "v1", "phase 1", "initial release"],
	"api gateway": ["api proxy", "api management", "api layer"],
	microservices: ["micro-services", "service-oriented", "soa"],
	"load balancer": ["load balancing", "traffic distribution", "lb"],
	"high availability": ["ha", "fault tolerance", "redundancy", "resilience"],
	"ci/cd": [
		"continuous integration",
		"continuous deployment",
		"devops pipeline",
	],
	"problem statement": ["problem", "challenge", "issue", "pain point"],
	"smart goals": [
		"specific goals",
		"measurable goals",
		"measurable objectives",
	],
	"given when then": ["gwt", "acceptance criteria", "scenario"],
	"risk mitigation": ["risk management", "risk strategy", "mitigation plan"],
	"functional requirements": [
		"functional specs",
		"functional capabilities",
		"features",
	],
	"non-functional requirements": [
		"nfr",
		"quality attributes",
		"performance requirements",
	],
};

function matchKeyPhrase(phrase: string, documentContent: string): boolean {
	const docLower = documentContent.toLowerCase();
	const phraseLower = phrase.toLowerCase();

	// 1. Direct match
	if (docLower.includes(phraseLower)) {
		return true;
	}

	// 2. Hyphen/space variations
	if (docLower.includes(phraseLower.replace(/-/g, " "))) {
		return true;
	}
	if (docLower.includes(phraseLower.replace(/\s+/g, "-"))) {
		return true;
	}

	// 3. Check synonyms
	const synonyms = PHRASE_SYNONYMS[phraseLower];
	if (synonyms) {
		for (const synonym of synonyms) {
			if (docLower.includes(synonym.toLowerCase())) {
				return true;
			}
		}
	}

	// 4. Check if document has a synonym that maps to this phrase
	for (const [canonical, syns] of Object.entries(PHRASE_SYNONYMS)) {
		if (syns.includes(phraseLower) && docLower.includes(canonical)) {
			return true;
		}
	}

	return false;
}

function calculateKeywordScoreWithSynonyms(
	keyPhrases: string[],
	documentContent: string,
): { score: number; found: string[]; missing: string[] } {
	if (keyPhrases.length === 0) {
		return { score: 80, found: [], missing: [] }; // Changed from 100
	}

	const found: string[] = [];
	const missing: string[] = [];

	for (const phrase of keyPhrases) {
		if (matchKeyPhrase(phrase, documentContent)) {
			found.push(phrase);
		} else {
			missing.push(phrase);
		}
	}

	// Weighted scoring: penalize heavily if >50% missing
	const coverage = found.length / keyPhrases.length;
	let score: number;

	if (coverage >= 0.9) {
		score = 100;
	} else if (coverage >= 0.8) {
		score = 90;
	} else if (coverage >= 0.7) {
		score = 75;
	} else if (coverage >= 0.5) {
		score = 55;
	} else if (coverage >= 0.3) {
		score = 35;
	} else {
		score = 15;
	}

	return { score, found, missing };
}

// ============================================================================
// PHASE 1.4: Fixed Similarity Scoring
// ============================================================================

function evaluateWithoutGolden(content: string, _docType: string): number {
	let score = 70; // Start at 70, not 100

	const wordCount = content.split(/\s+/).filter(Boolean).length;
	const sectionCount = (content.match(/^##\s+/gm) || []).length;
	const hasCodeBlocks = /```[\s\S]*?```/.test(content);
	const hasTables = /\|.*\|.*\|/.test(content);
	const hasDiagrams = /```(mermaid|ascii|diagram)[\s\S]*?```/i.test(content);

	// Adjust based on document complexity indicators
	if (wordCount > 2000) {
		score += 5;
	}
	if (sectionCount > 5) {
		score += 5;
	}
	if (hasCodeBlocks) {
		score += 5;
	}
	if (hasTables) {
		score += 5;
	}
	if (hasDiagrams) {
		score += 5;
	}

	// Cap at 85 without golden reference
	return Math.min(85, score);
}

function calculateSimilarityScoreFixed(params: {
	documentContent: string;
	goldenContent?: string;
	documentType: string;
}): {
	score: number;
	hasGolden: boolean;
	structureScore?: number;
	contentScore?: number;
	missingGroups?: string[];
} {
	const { documentContent, goldenContent, documentType } = params;

	// If no golden reference, use baseline expectations instead of 100
	if (!goldenContent) {
		const baselineScore = evaluateWithoutGolden(
			documentContent,
			documentType,
		);
		return {
			score: baselineScore,
			hasGolden: false,
		};
	}

	const documentSections = getSectionNames(documentContent);
	const goldenSections = getSectionNames(goldenContent);

	const documentGroups = new Set(
		documentSections
			.map(findSectionGroup)
			.filter((group): group is string => Boolean(group)),
	);
	const goldenGroups = new Set(
		goldenSections
			.map(findSectionGroup)
			.filter((group): group is string => Boolean(group)),
	);

	const intersection = [...documentGroups].filter((g) => goldenGroups.has(g));
	const union = new Set([...documentGroups, ...goldenGroups]);

	const structureScore =
		union.size > 0 ? intersection.length / union.size : 1;

	const documentWords = new Set(
		documentContent
			.toLowerCase()
			.split(/\s+/)
			.slice(0, MAX_WORDS_FOR_SIMILARITY)
			.filter((word) => word.length > 3),
	);
	const goldenWords = new Set(
		goldenContent
			.toLowerCase()
			.split(/\s+/)
			.slice(0, MAX_WORDS_FOR_SIMILARITY)
			.filter((word) => word.length > 3),
	);
	const wordIntersection = [...documentWords].filter((word) =>
		goldenWords.has(word),
	);
	const contentScore =
		goldenWords.size > 0 ? wordIntersection.length / goldenWords.size : 1;

	const score = Math.round(structureScore * 40 + contentScore * 60);

	return {
		score: Math.min(100, score),
		hasGolden: true,
		structureScore,
		contentScore,
		missingGroups: [...goldenGroups].filter(
			(group) => !documentGroups.has(group),
		),
	};
}

// ============================================================================
// Helper Functions
// ============================================================================

function resolveRequiredSections(input: EvalInput): string[] {
	if (input.requiredSections && input.requiredSections.length > 0) {
		return input.requiredSections;
	}
	return getRequiredGroupsForDocType(input.documentType);
}

function isGroupName(name: string) {
	return name in SECTION_SEMANTIC_GROUPS;
}

function getDocumentSections(documentContent: string) {
	return getSectionNames(documentContent);
}

function checkRequiredSections(
	documentSections: string[],
	requiredSections: string[],
) {
	const found: string[] = [];
	const missing: string[] = [];

	for (const required of requiredSections) {
		const matched = documentSections.some((section) =>
			isGroupName(required)
				? sectionMatchesGroup(section, required)
				: section.toLowerCase().includes(required.toLowerCase()),
		);

		if (matched) {
			found.push(required);
		} else {
			missing.push(required);
		}
	}

	return { found, missing };
}

function getExtras(documentSections: string[]) {
	return documentSections.filter((section) => !findSectionGroup(section));
}

// ============================================================================
// Scorer Creators (Using Enhanced Logic)
// ============================================================================

export function createCompletenessScorer() {
	return createScorer({
		id: "document-completeness",
		description: "Checks required sections with content depth validation.",
		type: { input: evalInputSchema, output: evalOutputSchema },
	})
		.preprocess(({ run }) => {
			const evalInput: EvalInput = run.input ?? {
				documentType: "general",
			};
			const requiredSections = resolveRequiredSections(evalInput);
			const documentSections = getDocumentSections(run.output);

			// Enhanced: Validate section content depth
			const validations = requiredSections.map((section) =>
				validateSectionContent(run.output, section),
			);

			const { found, missing } = checkRequiredSections(
				documentSections,
				requiredSections,
			);

			return {
				requiredSections,
				documentSections,
				found,
				missing,
				validations,
			};
		})
		.generateScore(({ results }) => {
			const { validations } = results.preprocessStepResult ?? {
				validations: [],
			};

			if (!validations || validations.length === 0) {
				return 0;
			}
			return calculateCompletenessScoreWithDepth(validations);
		});
}

export function createSimilarityScorer() {
	return createScorer({
		id: "document-similarity",
		description:
			"Compares document structure and content with reference (no auto-100).",
		type: { input: evalInputSchema, output: evalOutputSchema },
	})
		.preprocess(({ run }) => {
			const evalInput: EvalInput = run.input ?? {
				documentType: "general",
			};
			const result = calculateSimilarityScoreFixed({
				documentContent: run.output,
				goldenContent: evalInput.goldenContent,
				documentType: evalInput.documentType,
			});
			return result;
		})
		.generateScore(({ results }) => {
			return results.preprocessStepResult?.score ?? 70;
		});
}

export function createKeywordCoverageScorer() {
	return createScorer({
		id: "document-keyword-coverage",
		description: "Checks coverage of key phrases with semantic matching.",
		type: { input: evalInputSchema, output: evalOutputSchema },
	})
		.preprocess(({ run }) => {
			const evalInput: EvalInput = run.input ?? {
				documentType: "general",
			};
			const keyPhrases = evalInput.keyPhrases ?? [];

			const result = calculateKeywordScoreWithSynonyms(
				keyPhrases,
				run.output,
			);

			return { keyPhrases, ...result };
		})
		.generateScore(({ results }) => {
			return results.preprocessStepResult?.score ?? 80;
		});
}

export function createStructureScorer() {
	return createScorer({
		id: "document-structure",
		description:
			"Validates markdown structure with strict rules per document type.",
		type: { input: evalInputSchema, output: evalOutputSchema },
	})
		.preprocess(({ run }) => {
			const evalInput: EvalInput = run.input ?? {
				documentType: "general",
			};
			const result = validateStructureWithRules(
				run.output,
				evalInput.documentType,
			);
			return result;
		})
		.generateScore(({ results }) => {
			return results.preprocessStepResult?.score ?? 0;
		});
}

// ============================================================================
// Main Runner
// ============================================================================

export async function runNLPMetrics(input: {
	documentContent: string;
	documentType: string;
	requiredSections?: string[];
	keyPhrases?: string[];
	goldenContent?: string;
}): Promise<NLPEvalResult> {
	const startTime = Date.now();

	const completenessScorer = createCompletenessScorer();
	const similarityScorer = createSimilarityScorer();
	const keywordScorer = createKeywordCoverageScorer();
	const structureScorer = createStructureScorer();

	const scorerInput = {
		documentType: input.documentType,
		requiredSections: input.requiredSections,
		keyPhrases: input.keyPhrases,
		goldenContent: input.goldenContent,
	};

	const [completeness, similarity, keywords, structure] = await Promise.all([
		completenessScorer.run({
			input: scorerInput,
			output: input.documentContent,
		}),
		similarityScorer.run({
			input: scorerInput,
			output: input.documentContent,
		}),
		keywordScorer.run({
			input: scorerInput,
			output: input.documentContent,
		}),
		structureScorer.run({
			input: scorerInput,
			output: input.documentContent,
		}),
	]);

	const completenessDetails = completeness.preprocessStepResult ?? {
		found: [],
		missing: [],
		documentSections: [],
	};

	const similarityDetails = similarity.preprocessStepResult ?? {
		missingGroups: [],
		hasGolden: false,
	};

	const keywordDetails = keywords.preprocessStepResult ?? {
		found: [],
		missing: [],
	};
	const structureDetails = structure.preprocessStepResult ?? { issues: [] };

	// Ensure scores are valid numbers (default to 0 if undefined/null)
	const completenessScore = completeness.score ?? 0;
	const similarityScore = similarity.score ?? 0;
	const keywordScore = keywords.score ?? 0;
	const structureScore = structure.score ?? 0;

	const overallScore = Math.round(
		completenessScore * 0.3 +
			similarityScore * 0.25 +
			keywordScore * 0.25 +
			structureScore * 0.2,
	);

	return {
		completeness: {
			name: "completeness",
			score: completenessScore,
			details: {
				found: completenessDetails.found ?? [],
				missing: completenessDetails.missing ?? [],
				extras: getExtras(completenessDetails.documentSections ?? []),
			},
			feedback:
				completenessScore >= 80
					? "Document contains most required sections with adequate depth."
					: `Document has issues with completeness: ${(completenessDetails.missing ?? []).join(", ")}.`,
		},
		similarity: {
			name: "similarity",
			score: similarityScore,
			details: {
				found: [],
				missing: (similarityDetails.missingGroups ?? []).map(String),
			},
			feedback: similarityDetails.hasGolden
				? similarityScore >= 80
					? "Document aligns well with reference structure."
					: "Document structure/content differs from reference."
				: "No golden reference - baseline evaluation applied.",
		},
		keywords: {
			name: "keywords",
			score: keywordScore,
			details: {
				found: keywordDetails.found ?? [],
				missing: keywordDetails.missing ?? [],
			},
			feedback:
				keywordScore >= 80
					? "Document covers key topics comprehensively."
					: `Consider addressing: ${(keywordDetails.missing ?? [])
							.slice(0, 3)
							.join(", ")}.`,
		},
		structure: {
			name: "structure",
			score: structureScore,
			details: {
				found: [],
				missing: structureDetails.issues ?? [],
			},
			feedback:
				structureDetails.issues?.length === 0
					? "Document structure meets standards."
					: `Structure issues: ${structureDetails.issues
							?.slice(0, 2)
							.join("; ")}.`,
		},
		overallScore,
		executionTimeMs: Date.now() - startTime,
	};
}
