/**
 * Follow-Up Questions Generator
 *
 * Generates contextual follow-up questions based on document type and content.
 * These questions appear in the CopilotKit sidebar to guide users in refining their documents.
 */

import type { DocumentType } from "@repo/agent-types";

/**
 * Follow-up question with context
 */
export interface FollowUpQuestion {
	question: string;
	category: "expand" | "clarify" | "refine" | "complete";
	priority: number; // 1-3, where 1 is highest priority
}

/**
 * Options for generating follow-up questions
 */
export interface FollowUpQuestionOptions {
	documentType: DocumentType;
	document?: string;
	maxQuestions?: number;
	isNewDocument?: boolean;
	userRequest?: string;
}

/**
 * Extract the document title/topic from the content
 */
function extractDocumentTopic(document: string): string {
	// Try to extract from H1 heading
	const h1Match = document.match(/^#\s+(.+)$/m);
	if (h1Match) {
		return h1Match[1].trim();
	}

	// Try first line if it looks like a title
	const firstLine = document.split("\n")[0]?.trim();
	if (firstLine && firstLine.length < 100 && !firstLine.startsWith("-")) {
		return firstLine.replace(/^#+\s*/, "");
	}

	return "this document";
}

/**
 * Extract section headings from the document
 */
function extractSections(document: string): string[] {
	const headingMatches = document.match(/^#{2,3}\s+(.+)$/gm) || [];
	return headingMatches.map((h) => h.replace(/^#{2,3}\s+/, "").trim());
}

/**
 * Identify what's potentially missing or could be expanded
 */
function analyzeDocumentGaps(
	document: string,
	documentType: DocumentType,
	sections: string[],
): { missing: string[]; incomplete: string[]; suggestions: string[] } {
	const lowercaseDoc = document.toLowerCase();
	const _lowercaseSections = sections.map((s) => s.toLowerCase());

	const missing: string[] = [];
	const incomplete: string[] = [];
	const suggestions: string[] = [];

	// Document-type specific analysis
	switch (documentType) {
		case "prd":
			if (
				!lowercaseDoc.includes("success metric") &&
				!lowercaseDoc.includes("kpi")
			) {
				missing.push("success metrics and KPIs");
			}
			if (
				!lowercaseDoc.includes("user stor") &&
				!lowercaseDoc.includes("as a user") &&
				!lowercaseDoc.includes("feature item") &&
				!lowercaseDoc.includes("f-00")
			) {
				missing.push("detailed features");
			}
			if (!lowercaseDoc.includes("acceptance criteria")) {
				missing.push("acceptance criteria");
			}
			if (
				!lowercaseDoc.includes("timeline") &&
				!lowercaseDoc.includes("milestone")
			) {
				missing.push("timeline and milestones");
			}
			if (!lowercaseDoc.includes("risk")) {
				suggestions.push("risk assessment and mitigation strategies");
			}
			break;

		case "proposal":
			if (
				!lowercaseDoc.includes("budget") &&
				!lowercaseDoc.includes("cost")
			) {
				missing.push("budget breakdown and cost estimates");
			}
			if (
				!lowercaseDoc.includes("timeline") &&
				!lowercaseDoc.includes("schedule")
			) {
				missing.push("project timeline with milestones");
			}
			if (!lowercaseDoc.includes("deliverable")) {
				missing.push("specific deliverables");
			}
			if (!lowercaseDoc.includes("risk")) {
				suggestions.push("risk assessment");
			}
			break;

		case "architecture":
			if (!lowercaseDoc.includes("security")) {
				missing.push("security considerations");
			}
			if (
				!lowercaseDoc.includes("data flow") &&
				!lowercaseDoc.includes("data model")
			) {
				missing.push("data flow diagrams");
			}
			if (
				!lowercaseDoc.includes("deployment") &&
				!lowercaseDoc.includes("infrastructure")
			) {
				missing.push("deployment architecture");
			}
			if (!lowercaseDoc.includes("scalab")) {
				suggestions.push("scalability considerations");
			}
			break;

		case "technical_spec":
			if (
				!lowercaseDoc.includes("api") &&
				!lowercaseDoc.includes("endpoint")
			) {
				missing.push("API specifications");
			}
			if (
				!lowercaseDoc.includes("error") &&
				!lowercaseDoc.includes("exception")
			) {
				missing.push("error handling details");
			}
			if (!lowercaseDoc.includes("test")) {
				suggestions.push("testing strategy");
			}
			break;

		case "api_spec":
			if (!lowercaseDoc.includes("auth")) {
				missing.push("authentication and authorization details");
			}
			if (
				!lowercaseDoc.includes("error") &&
				!lowercaseDoc.includes("status code")
			) {
				missing.push("error response schemas");
			}
			if (
				!lowercaseDoc.includes("example") &&
				!lowercaseDoc.includes("sample")
			) {
				missing.push("request/response examples");
			}
			break;

		case "user_story":
			if (!lowercaseDoc.includes("acceptance criteria")) {
				missing.push("acceptance criteria");
			}
			if (
				!lowercaseDoc.includes("task") &&
				!lowercaseDoc.includes("subtask")
			) {
				suggestions.push("task breakdown");
			}
			break;
	}

	// Check for TODO/TBD markers
	if (/\[todo\]|\[tbd\]|\[placeholder\]|xxx|fixme/i.test(document)) {
		incomplete.push("sections marked as TODO/TBD");
	}

	// Check for very short sections
	const sectionContents = document.split(/^#{2,3}\s+/m);
	for (let i = 1; i < sectionContents.length && i <= sections.length; i++) {
		const content = sectionContents[i];
		if (content && content.trim().length < 100) {
			incomplete.push(
				`the "${sections[i - 1]}" section which seems brief`,
			);
			break; // Only mention one
		}
	}

	return { missing, incomplete, suggestions };
}

/**
 * Find the shortest section that could use more content
 */
function findShortestSection(
	document: string,
	sections: string[],
): { name: string; length: number } | null {
	const sectionContents = document.split(/^#{2,3}\s+/m);
	let shortest: { name: string; length: number } | null = null;

	for (let i = 1; i < sectionContents.length && i <= sections.length; i++) {
		const content = sectionContents[i];
		const length = content?.trim().length || 0;
		if (length > 0 && (!shortest || length < shortest.length)) {
			shortest = { name: sections[i - 1], length };
		}
	}

	return shortest;
}

/**
 * Generate varied contextual questions based on document analysis
 */
function generateContextualQuestions(
	document: string,
	sections: string[],
	topic: string,
): string[] {
	const questions: string[] = [];
	const lowercaseDoc = document.toLowerCase();

	// Check for opportunities to add examples
	if (
		!lowercaseDoc.includes("example") &&
		!lowercaseDoc.includes("for instance")
	) {
		questions.push(
			"Would you like me to add concrete examples to illustrate the key points?",
		);
	}

	// Check for opportunities to add diagrams/visuals description
	if (
		!lowercaseDoc.includes("diagram") &&
		!lowercaseDoc.includes("figure") &&
		!lowercaseDoc.includes("flowchart")
	) {
		questions.push(
			"Should I add descriptions for diagrams or visual representations?",
		);
	}

	// Check for next steps / action items
	if (
		!lowercaseDoc.includes("next step") &&
		!lowercaseDoc.includes("action item") &&
		!lowercaseDoc.includes("todo")
	) {
		questions.push(
			"Would you like me to add a section for next steps or action items?",
		);
	}

	// Check for summary/conclusion
	if (
		!lowercaseDoc.includes("summary") &&
		!lowercaseDoc.includes("conclusion") &&
		document.length > 1000
	) {
		questions.push(
			"Should I add an executive summary or conclusion section?",
		);
	}

	// Find shortest section to expand
	const shortest = findShortestSection(document, sections);
	if (shortest && shortest.length < 300) {
		questions.push(
			`The "${shortest.name}" section could use more detail. Would you like me to expand it?`,
		);
	}

	// Topic-specific refinement
	if (topic && topic !== "this document") {
		questions.push(
			`Is there a specific aspect of "${topic}" you'd like me to elaborate on?`,
		);
	}

	return questions;
}

/**
 * Generate a dynamic, contextual follow-up question
 */
export function generateFollowUpQuestions(
	options: FollowUpQuestionOptions,
): string[] {
	const {
		documentType,
		document = "",
		maxQuestions = 1,
		isNewDocument: _isNewDocument = false,
		userRequest: _userRequest = "",
	} = options;

	if (!document || document.trim().length === 0) {
		return ["What would you like me to help you create?"];
	}

	const topic = extractDocumentTopic(document);
	const sections = extractSections(document);
	const gaps = analyzeDocumentGaps(document, documentType, sections);

	const questions: string[] = [];

	// Priority 1: Missing critical elements (document-type specific)
	if (gaps.missing.length > 0) {
		const missingItems = gaps.missing.slice(0, 2);
		if (missingItems.length === 1) {
			questions.push(
				`Would you like me to add ${missingItems[0]} to strengthen the document?`,
			);
		} else {
			questions.push(
				`I could enhance this with ${missingItems[0]} and ${missingItems[1]}. Would you like me to add these?`,
			);
		}
	}

	// Priority 2: Incomplete sections (TODO markers, etc.)
	if (gaps.incomplete.length > 0 && questions.length < maxQuestions) {
		questions.push(
			`I noticed ${gaps.incomplete[0]}. Should I expand on that?`,
		);
	}

	// Priority 3: Document-type specific suggestions
	if (gaps.suggestions.length > 0 && questions.length < maxQuestions) {
		questions.push(
			`Would you like me to add ${gaps.suggestions[0]} to make this more comprehensive?`,
		);
	}

	// Priority 4: Content-based contextual questions (varied and specific)
	if (questions.length < maxQuestions) {
		const contextualQuestions = generateContextualQuestions(
			document,
			sections,
			topic,
		);
		// Shuffle to avoid always showing the same question
		const shuffled = contextualQuestions.sort(() => Math.random() - 0.5);
		for (const q of shuffled) {
			if (questions.length >= maxQuestions) {
				break;
			}
			if (!questions.includes(q)) {
				questions.push(q);
			}
		}
	}

	// Fallback: Generic but document-aware question
	if (questions.length === 0) {
		const docTypeLabel = documentType.replace(/_/g, " ");
		questions.push(
			`What aspect of this ${docTypeLabel} would you like me to refine or expand?`,
		);
	}

	return questions.slice(0, maxQuestions);
}

/**
 * Build the follow-up question instruction for the system prompt
 */
export function buildFollowUpInstructions(documentType: DocumentType): string {
	const docTypeLabel = documentType.replace(/_/g, " ").toUpperCase();

	return `
## Follow-Up & Clarifying Questions (CRITICAL - DO NOT SKIP)

When you call the write_document_local tool, you MUST ALSO include a brief message in your
response content (a short acknowledgment of what you created/updated). It MUST NOT be empty.

### Asking the user for clarification or a decision
When you need the user to clarify intent or make a choice, ask a CLARIFYING QUESTION by
outputting a fenced code block tagged \`clarifying-question\` that contains ONLY JSON — with
no prose before or after the block in that reply:

\`\`\`clarifying-question
{ "question": "<one concise question>", "options": ["<short answer>", "<short answer>", "<short answer>"] }
\`\`\`

The app renders that block as an interactive question card with clickable options plus a
"type your own" field; the user's answer comes back to you on the next turn — then continue
using it without asking again. Provide up to 3 short, distinct options (the user can always
type their own). If the user dismisses the question, add it to an "Open Questions" section
and pause instead of guessing. Follow the project's clarifying-question frequency policy
(MINIMAL = ask rarely, only when truly blocked; BALANCED = ask on material ambiguity;
THOROUGH = ask proactively). Ask at most one question per turn unless the policy is THOROUGH.

### Make questions specific and contextual
DO NOT use generic questions like "Would you like me to expand any section?". Reference the
ACTUAL content/intent. Use calm, neutral language; never imply an answer is required or "best".

### Example clarifying question for ${docTypeLabel} documents (output EXACTLY this shape, nothing else)
\`\`\`clarifying-question
{ "question": "Which datastore should the API use?", "options": ["PostgreSQL", "MongoDB", "DynamoDB"] }
\`\`\`
`;
}
