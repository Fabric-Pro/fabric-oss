/**
 * Markdown Parser Helper
 *
 * Utilities for parsing markdown structure for validation.
 */

import { SECTION_SEMANTIC_GROUPS, sectionMatchesGroup } from "../documents";

export interface ParsedHeading {
	level: number; // 1-6
	text: string;
	line: number;
}

export interface ParsedSection {
	name: string;
	level: number;
	startLine: number;
	endLine?: number;
	content: string;
	subsections: ParsedSection[];
}

/**
 * Parse headings from markdown text.
 *
 * Skips lines inside fenced code blocks so `# comment` in a shell snippet or
 * `## Example` in an embedded markdown sample does not get mistaken for a
 * real section heading. A fence opens on a line starting with three or more
 * backticks or tildes (optionally after up to three spaces of indent) and
 * closes on a line with the same marker character and at least the same
 * number of repetitions — matching the CommonMark spec for the cases that
 * matter here.
 */
export function parseHeadings(markdown: string): ParsedHeading[] {
	const lines = markdown.split("\n");
	const headings: ParsedHeading[] = [];
	let fenceChar: "`" | "~" | null = null;
	let fenceLen = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			const ch = marker[0] as "`" | "~";
			if (fenceChar === null) {
				fenceChar = ch;
				fenceLen = marker.length;
				continue;
			}
			if (ch === fenceChar && marker.length >= fenceLen) {
				fenceChar = null;
				fenceLen = 0;
				continue;
			}
		}

		if (fenceChar !== null) {
			continue;
		}

		const match = line.match(/^(#{1,6})\s+(.+)$/);
		if (match) {
			headings.push({
				level: match[1].length,
				text: match[2].trim(),
				line: i + 1,
			});
		}
	}

	return headings;
}

/**
 * Parse sections from markdown text
 */
export function parseSections(markdown: string): ParsedSection[] {
	const lines = markdown.split("\n");
	const headings = parseHeadings(markdown);
	const sections: ParsedSection[] = [];

	if (headings.length === 0) {
		return [];
	}

	// Build section tree
	for (let i = 0; i < headings.length; i++) {
		const heading = headings[i];
		const nextHeading = headings[i + 1];
		const startLine = heading.line;
		const endLine = nextHeading ? nextHeading.line - 1 : lines.length;

		const content = lines
			.slice(startLine - 1, endLine)
			.join("\n")
			.trim();

		const section: ParsedSection = {
			name: heading.text,
			level: heading.level,
			startLine,
			endLine,
			content,
			subsections: [],
		};

		// Find parent section (last section with lower level)
		if (i > 0) {
			for (let j = i - 1; j >= 0; j--) {
				if (headings[j].level < heading.level) {
					const parentIndex = sections.findIndex(
						(s) => s.startLine === headings[j].line,
					);
					if (parentIndex !== -1) {
						sections[parentIndex].subsections.push(section);
						break;
					}
				}
			}
		}

		// Only add top-level sections to root
		if (heading.level === 2 || i === 0) {
			sections.push(section);
		}
	}

	return sections;
}

/**
 * Get section names (h2 headings)
 */
export function getSectionNames(markdown: string): string[] {
	const headings = parseHeadings(markdown);
	return headings.filter((h) => h.level === 2).map((h) => h.text);
}

/**
 * Check if required sections are present
 */
export function hasRequiredSections(
	markdown: string,
	requiredSections: string[],
): { missing: string[]; found: string[] } {
	const foundSections = getSectionNames(markdown);
	const missing = requiredSections.filter((req) => {
		const isGroup = Object.hasOwn(SECTION_SEMANTIC_GROUPS, req);
		if (isGroup) {
			return !foundSections.some((found) =>
				sectionMatchesGroup(found, req),
			);
		}

		return !foundSections.some((found) =>
			found.toLowerCase().includes(req.toLowerCase()),
		);
	});

	return {
		missing,
		found: foundSections,
	};
}

/**
 * Check heading hierarchy (h2 should come before h3, etc.)
 */
export function validateHeadingHierarchy(markdown: string): {
	isValid: boolean;
	errors: Array<{ line: number; message: string }>;
} {
	const headings = parseHeadings(markdown);
	const errors: Array<{ line: number; message: string }> = [];

	if (headings.length === 0) {
		return { isValid: true, errors: [] };
	}

	// First heading should be h2 (##)
	if (headings[0].level > 2) {
		errors.push({
			line: headings[0].line,
			message: `First heading should be h2 (##), found h${headings[0].level}`,
		});
	}

	// Check for level jumps (h2 -> h4 is invalid, should be h2 -> h3)
	for (let i = 1; i < headings.length; i++) {
		const prev = headings[i - 1];
		const curr = headings[i];

		if (curr.level > prev.level + 1) {
			errors.push({
				line: curr.line,
				message: `Heading level jump: h${prev.level} -> h${curr.level} (should be h${prev.level + 1})`,
			});
		}
	}

	return {
		isValid: errors.length === 0,
		errors,
	};
}
