import { ORPCError } from "@orpc/client";
import {
	AIProviderNotConfiguredError,
	generateObject,
	getAIModelWithMetadata,
	logModelUsageAsync,
} from "@repo/ai";
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	bulkCreateStories,
	db,
	type StoryPriority,
	type StorySize,
} from "@repo/database";
import { zodSchema } from "ai";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { clearProjectStoriesAndAttachments } from "../../lib/clear-project-stories-with-attachments";

// =============================================================================
// Constants
// =============================================================================

/** Documents below this size work fine with single-pass AI extraction. */
const SMALL_DOC_THRESHOLD = 4000;

// =============================================================================
// Markdown heading parser (lightweight, inline — no external dependency)
// =============================================================================

interface MarkdownHeading {
	level: number; // 1-6
	text: string; // heading text without # prefix
	line: number; // 0-indexed line number
}

/**
 * Extract markdown headings from a document, skipping fenced code blocks.
 */
function parseMarkdownHeadings(markdown: string): MarkdownHeading[] {
	const lines = markdown.split("\n");
	const headings: MarkdownHeading[] = [];
	let inFence = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Track fenced code blocks
		if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			continue;
		}

		const match = line.match(/^(#{1,6})\s+(.+)$/);
		if (match) {
			headings.push({
				level: match[1].length,
				text: match[2].trim(),
				line: i,
			});
		}
	}

	return headings;
}

/**
 * Extract the markdown content for a section starting at a heading,
 * ending at the next heading of the same or higher level (or end of doc).
 */
function extractSectionContent(
	lines: string[],
	headingIdx: number,
	allHeadings: MarkdownHeading[],
): string {
	const heading = allHeadings[headingIdx];
	let endLine = lines.length;

	// Find the next heading at the same or higher (lower number) level
	for (let i = headingIdx + 1; i < allHeadings.length; i++) {
		if (allHeadings[i].level <= heading.level) {
			endLine = allHeadings[i].line;
			break;
		}
	}

	return lines.slice(heading.line, endLine).join("\n").trim();
}

// =============================================================================
// AI-powered feature extraction — single-pass (for small docs or fallback)
// =============================================================================

const FeatureExtractionSchema = z.object({
	features: z.array(
		z.object({
			title: z.string().describe("Feature title, extracted verbatim"),
			description: z
				.string()
				.optional()
				.describe(
					"Feature description verbatim from the document. Preserve all markdown formatting. Omit if not present in source.",
				),
			acceptanceCriteria: z
				.string()
				.optional()
				.describe(
					"Acceptance criteria verbatim from the document. Only include if explicitly written in the source. NEVER generate placeholder text like 'Given... When... Then...'. Omit if not present.",
				),
			priority: z
				.enum(["P0_CRITICAL", "P1_HIGH", "P2_MEDIUM", "P3_LOW"])
				.optional()
				.describe("Only extract if explicitly stated in the document"),
			size: z
				.enum(["XS", "S", "M", "L", "XL"])
				.optional()
				.describe("Only extract if explicitly stated in the document"),
			storyPoints: z
				.number()
				.optional()
				.describe("Only extract if explicitly stated in the document"),
			labels: z
				.array(z.string())
				.optional()
				.describe("Only extract if explicitly stated in the document"),
			tasks: z
				.array(
					z.object({
						title: z.string(),
						description: z.string().optional(),
						estimatedHours: z.number().optional(),
					}),
				)
				.optional()
				.describe(
					"Subtasks/tasks listed under this feature. Only extract if explicitly present.",
				),
		}),
	),
});

async function singlePassAIExtraction(
	markdown: string,
	userId: string,
	organizationId?: string,
	projectId?: string,
): Promise<ParsedStory[] | null> {
	try {
		const taskType = "COMPLEX" as const;
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType },
			{ userId, organizationId },
		);

		const generationStart = Date.now();
		const prompt = `Extract all features from this markdown document into structured data.

CRITICAL RULES:
- Each distinct feature in the document MUST be returned as a SEPARATE item in the features array.
- If the document contains 10 features, you MUST return 10 items. Never merge multiple features into one.
- Extract ONLY content that explicitly exists in the document. NEVER generate, infer, or fabricate any text.
- For every field: if the document does not contain that information, OMIT the field entirely. Do not fill in placeholders or templates.
- Preserve all original markdown formatting verbatim (bullet lists, numbered lists, bold, code blocks, newlines).

Document:

${markdown}`;
		// Scaled mode: this pass extracts every feature VERBATIM from the document,
		// so output tracks the source markdown. Without an explicit budget
		// Databricks/Anthropic-direct truncate the extraction at their injected
		// defaults (dropping trailing features); `undefined` for providers that
		// don't need the workaround.
		const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
			inputChars: markdown.length,
			promptChars: prompt.length,
		});
		const { object, usage } = await generateObject({
			model,
			schema: zodSchema(FeatureExtractionSchema),
			abortSignal: AbortSignal.timeout(90_000),
			prompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		});

		trackUsage();
		logModelUsageAsync({
			context: { userId, organizationId },
			metadata,
			taskType,
			usage,
			latencyMs: Date.now() - generationStart,
			projectId,
		});

		if (!object.features || object.features.length === 0) {
			return null;
		}

		return object.features;
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			return null;
		}
		console.error(
			"AI feature extraction failed, falling back to next strategy:",
			error,
		);
		return null;
	}
}

// =============================================================================
// Heading-indexed extraction (for large docs with headings)
// =============================================================================

const HeadingClassificationSchema = z.object({
	featureHeadingNumbers: z
		.array(z.number())
		.describe(
			"The 0-based index numbers of headings that represent the START of individual features. Do not include sub-section headings like Acceptance Criteria, Tasks, Notes, Description, Release Notes, etc.",
		),
});

/**
 * Two-pass extraction for large documents:
 * 1. Send heading index to AI to classify which are feature boundaries
 * 2. Split document at those boundaries using code
 * 3. Parse each section with regex for structured fields
 */
async function headingIndexedExtraction(
	markdown: string,
	headings: MarkdownHeading[],
	userId: string,
	organizationId?: string,
	projectId?: string,
): Promise<ParsedStory[] | null> {
	try {
		// Build the numbered heading index for the AI
		const headingIndex = headings
			.map((h, i) => `${i}. ${"#".repeat(h.level)} ${h.text}`)
			.join("\n");

		// Pass 1: Classify headings (cheap SIMPLE model call)
		const taskType = "SIMPLE" as const;
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType },
			{ userId, organizationId },
		);

		const generationStart = Date.now();
		const { object, usage } = await generateObject({
			model,
			schema: zodSchema(HeadingClassificationSchema),
			abortSignal: AbortSignal.timeout(15_000),
			prompt: `Here is the heading structure of a feature list document. Each line is: index. heading

${headingIndex}

Identify which headings represent the START of individual features — the LEAF-LEVEL items that each describe one specific capability.
- Pick the DEEPEST heading level that contains actionable feature items (with descriptions, acceptance criteria, etc.)
- If the document has a hierarchy like "# EPIC > ## FEAT > ### F-XXX", the ### F-XXX headings are the individual features — NOT the ## FEAT groupings
- If the document has only "## Feature 1", "## Feature 2" with no sub-headings, then those ## headings ARE the features
- Do NOT include parent/grouping headings (e.g., "# EPIC-001:", "## FEAT-001:") when they contain sub-feature headings underneath them
- Do NOT include sub-section headings within a feature (e.g., "Acceptance Criteria", "Tasks", "Description", "User Story", "Notes / Links", "Release Notes", "Dependencies")
- Return the 0-based index numbers of the feature-start headings only`,
		});

		trackUsage();
		logModelUsageAsync({
			context: { userId, organizationId },
			metadata,
			taskType,
			usage,
			latencyMs: Date.now() - generationStart,
			projectId,
		});

		const featureIndices = object.featureHeadingNumbers;
		if (!featureIndices || featureIndices.length === 0) {
			return null;
		}

		// Pass 2: Extract sections (pure code)
		const lines = markdown.split("\n");
		const stories: ParsedStory[] = [];

		for (const idx of featureIndices) {
			if (idx < 0 || idx >= headings.length) {
				continue;
			}
			const sectionContent = extractSectionContent(lines, idx, headings);

			// Parse each section into title + description
			const story = parseStorySection(sectionContent);
			if (story?.title) {
				stories.push(story);
			}
		}

		return stories.length > 0 ? stories : null;
	} catch (error) {
		console.error(
			"Heading-indexed extraction failed, falling back to next strategy:",
			error,
		);
		return null;
	}
}

// =============================================================================
// Regex-based fallback parser
// =============================================================================

interface ParsedStory {
	title: string;
	description?: string;
	acceptanceCriteria?: string;
	priority?: StoryPriority;
	size?: StorySize;
	storyPoints?: number;
	labels?: string[];
	tasks?: {
		title: string;
		description?: string;
		estimatedHours?: number;
	}[];
}

/**
 * Parse markdown features into structured data (regex fallback)
 * Handles various formats from AI-generated feature documents:
 * - FEATURE_START/FEATURE_END delimiters (primary; legacy STORY_START/STORY_END
 *   still accepted so previously-generated documents keep parsing)
 * - Standard F-XXX or FEAT-XXX format (legacy US-XXX still accepted)
 * - Story-N format
 * - Horizontal rule separators (---)
 * - Numbered story patterns
 */
function parseStoriesFromMarkdownRegex(markdown: string): ParsedStory[] {
	const stories: ParsedStory[] = [];

	// Normalize dashes: Replace all unicode dash variants with regular hyphen
	const normalizedMarkdown = markdown.replace(/[\u2010-\u2015]/g, "-");

	// Try multiple parsing strategies in order of reliability

	// Strategy 1: FEATURE_START/FEATURE_END delimiters (most reliable).
	// Legacy STORY_START/STORY_END is still accepted for documents generated
	// before the User Story → Feature terminology change.
	const delimiterPattern =
		/<!--\s*(?:FEATURE|STORY)_START\s*-->([\s\S]*?)<!--\s*(?:FEATURE|STORY)_END\s*-->/gi;
	let match = delimiterPattern.exec(normalizedMarkdown);
	while (match !== null) {
		const storyContent = match[1].trim();
		if (storyContent) {
			const story = parseStorySection(storyContent);
			if (story?.title) {
				stories.push(story);
			}
		}
		match = delimiterPattern.exec(normalizedMarkdown);
	}

	if (stories.length > 0) {
		return stories;
	}

	// Strategy 2: Split by US-XXX, F-XXX, or FEAT-XXX headers
	const usHeaderPattern = /\n(?=#{1,3}\s+(?:US|F(?:EAT)?)-?\d+[:\s])/gi;
	let sections = normalizedMarkdown.split(usHeaderPattern);

	for (const section of sections) {
		if (!section.trim()) {
			continue;
		}

		const firstLine = section.split("\n")[0];
		if (!firstLine.match(/#{1,3}\s+(?:US|F(?:EAT)?)-?\d+[:\s]/i)) {
			continue;
		}

		const lowerFirstLine = firstLine.toLowerCase();
		if (
			lowerFirstLine.includes("epic overview") ||
			lowerFirstLine.includes("epic summary") ||
			lowerFirstLine.includes("mvp stories") ||
			lowerFirstLine.includes("enhancement stories")
		) {
			continue;
		}

		const story = parseStorySection(section);
		if (
			story?.title &&
			!story.title.toLowerCase().includes("epic overview")
		) {
			stories.push(story);
		}
	}

	// Strategy 3: Try Story-N or User Story N format
	if (stories.length === 0) {
		const storyNPattern =
			/\n(?=#{1,3}\s+(?:Story|User Story)\s*[-#]?\d+[:\s])/gi;
		sections = normalizedMarkdown.split(storyNPattern);

		for (const section of sections) {
			if (!section.trim()) {
				continue;
			}
			const firstLine = section.split("\n")[0];
			if (
				!firstLine.match(
					/#{1,3}\s+(?:Story|User Story)\s*[-#]?\d+[:\s]/i,
				)
			) {
				continue;
			}

			const story = parseStorySection(section);
			if (story?.title) {
				stories.push(story);
			}
		}
	}

	// Strategy 4: Try horizontal rule separators (---)
	if (stories.length === 0) {
		const hrSections = normalizedMarkdown.split(/\n---+\n/);
		for (const section of hrSections) {
			if (!section.trim()) {
				continue;
			}

			const story = parseStorySection(section);
			if (story?.title && story.title.length > 10) {
				stories.push(story);
			}
		}
	}

	// Strategy 5: Try numbered story pattern (## 1. Story Title)
	if (stories.length === 0) {
		const numberedPattern = /\n(?=#{1,3}\s+\d+\.\s+)/g;
		sections = normalizedMarkdown.split(numberedPattern);

		for (const section of sections) {
			if (!section.trim()) {
				continue;
			}
			const firstLine = section.split("\n")[0];
			if (!firstLine.match(/#{1,3}\s+\d+\.\s+/)) {
				continue;
			}

			const story = parseStorySection(section);
			if (story?.title) {
				stories.push(story);
			}
		}
	}

	// Strategy 6: Alternative "As a [user]" pattern parsing
	if (stories.length === 0) {
		const alternativeStories = parseAlternativeFormat(normalizedMarkdown);
		stories.push(...alternativeStories);
	}

	return stories;
}

function parseStorySection(section: string): ParsedStory | null {
	const allLines = section.split("\n");
	// Find first non-empty line for title extraction
	const firstNonEmptyIdx = allLines.findIndex((line) => line.trim());
	if (firstNonEmptyIdx === -1) {
		return null;
	}

	const story: ParsedStory = {
		title: "",
	};

	// Extract title from first non-empty line
	const titleMatch = allLines[firstNonEmptyIdx].match(
		/(?:#{1,3}\s*)?(?:\*{2})?(?:(?:US|F(?:EAT)?)-?\d+|User Story\s*\d+|Feature\s*\d+|\[(?:US|F(?:EAT)?)-?\d+\])(?:\*{2})?[:\s]+(.+)/i,
	);
	if (titleMatch) {
		story.title = titleMatch[1].trim().replace(/\*{2}/g, "");
	} else {
		// Try to extract title from "As a [user]" format
		const asAMatch = allLines[firstNonEmptyIdx].match(
			/As a[n]?\s+(.+?),\s*I want\s+(.+)/i,
		);
		if (asAMatch) {
			story.title = `As a ${asAMatch[1]}, I want ${asAMatch[2]}`;
		} else {
			// Use first line as title
			story.title = allLines[firstNonEmptyIdx]
				.replace(/^#{1,3}\s*/, "")
				.replace(/^\*{2}/, "")
				.replace(/\*{2}$/, "")
				.trim();
		}
	}

	// Everything after the title line goes into description verbatim,
	// preserving the original document order and formatting.
	// No hardcoded section labels — works with any custom prompt format.
	const description = allLines
		.slice(firstNonEmptyIdx + 1)
		.join("\n")
		.trim();

	if (description) {
		story.description = description;
	}

	return story.title ? story : null;
}

function parseAlternativeFormat(markdown: string): ParsedStory[] {
	const stories: ParsedStory[] = [];

	const asAPattern =
		/As a[n]?\s+([^,]+),\s*I want\s+([^,]+?)(?:,?\s*so that\s+([^.]+))?\./gi;
	let match = asAPattern.exec(markdown);

	while (match !== null) {
		const userType = match[1].trim();
		const want = match[2].trim();
		const benefit = match[3]?.trim();

		stories.push({
			title: `As a ${userType}, I want ${want}${benefit ? ` so that ${benefit}` : ""}`,
		});

		match = asAPattern.exec(markdown);
	}

	return stories;
}

// =============================================================================
// Size-gated extraction router
// =============================================================================

async function extractFeatures(
	markdown: string,
	userId: string,
	organizationId?: string,
	projectId?: string,
): Promise<ParsedStory[]> {
	// Large docs with headings: use heading-indexed extraction
	if (markdown.length >= SMALL_DOC_THRESHOLD) {
		const headings = parseMarkdownHeadings(markdown);
		if (headings.length >= 2) {
			const result = await headingIndexedExtraction(
				markdown,
				headings,
				userId,
				organizationId,
				projectId,
			);
			if (result && result.length > 0) {
				return result;
			}
		}
		// Fall through to single-pass AI
	}

	// Small docs OR heading-indexed extraction failed: single-pass AI
	const aiResult = await singlePassAIExtraction(
		markdown,
		userId,
		organizationId,
		projectId,
	);
	if (aiResult && aiResult.length > 0) {
		return aiResult;
	}

	// Final safety net: regex fallback
	return parseStoriesFromMarkdownRegex(markdown);
}

// =============================================================================
// Procedure
// =============================================================================

export const pushToKanbanProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/push-to-kanban",
		tags: ["Projects", "Stories"],
		summary: "Push document to Kanban",
		description:
			"Parse a features document and create features/tasks in the Kanban board",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			organizationId: z.string().nullable().optional(),
			clearExisting: z.boolean().optional().default(false),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Fetch the document
		const document = await db.projectDocument.findFirst({
			where: {
				id: input.documentId,
				projectId: input.projectId,
			},
		});

		if (!document) {
			throw new ORPCError("NOT_FOUND", {
				message: "Document not found",
			});
		}

		if (document.type !== "USER_STORY") {
			throw new ORPCError("BAD_REQUEST", {
				message: "Document must be of type USER_STORY",
			});
		}

		// Extract features using size-gated strategy
		const parsedStories = await extractFeatures(
			document.content,
			user.id,
			organizationId ?? undefined,
			input.projectId,
		);

		if (parsedStories.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"No features could be parsed from the document. Make sure the document contains clearly separated features.",
			});
		}

		// Optionally clear existing pipeline-generated stories
		if (input.clearExisting) {
			await clearProjectStoriesAndAttachments(input.projectId, true);
		}

		// Create stories in the database
		const createdStories = await bulkCreateStories(
			input.projectId,
			user.id,
			parsedStories,
			document.workflowId ?? undefined,
			"AI_UPDATE",
		);

		const tasksCreated = createdStories.reduce(
			(sum, story) => sum + (story.tasks?.length ?? 0),
			0,
		);

		await db.projectDocument.update({
			where: { id: input.documentId },
			data: {
				status: "COMPLETE",
				updatedAt: new Date(),
			},
		});

		return {
			success: true,
			storiesCreated: createdStories.length,
			tasksCreated,
			stories: createdStories.map((story) => ({
				id: story.id,
				identifier: story.identifier,
				title: story.title,
				taskCount: story.tasks?.length ?? 0,
			})),
		};
	});
