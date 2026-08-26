/**
 * Formatting Checker
 *
 * Validates markdown formatting using regex patterns and rules.
 */

export interface FormattingError {
	type:
		| "heading"
		| "list"
		| "table"
		| "code_block"
		| "paragraph"
		| "blank_line";
	severity: "error" | "warning";
	message: string;
	line?: number;
	suggestion?: string;
}

/**
 * Check markdown formatting
 */
export function checkFormatting(markdown: string): {
	isValid: boolean;
	errors: FormattingError[];
	warnings: FormattingError[];
} {
	const errors: FormattingError[] = [];
	const warnings: FormattingError[] = [];
	const lines = markdown.split("\n");

	// Check for headings without blank lines
	const headingErrors = checkHeadingBlankLines(markdown, lines);
	errors.push(...headingErrors);

	// Check for malformed tables
	const tableErrors = checkTableFormatting(markdown, lines);
	errors.push(...tableErrors);

	// Check for unclosed code blocks
	const codeBlockErrors = checkCodeBlocks(markdown, lines);
	errors.push(...codeBlockErrors);

	// Check for inconsistent list markers
	const listWarnings = checkListConsistency(markdown, lines);
	warnings.push(...listWarnings);

	// Check for paragraphs without blank lines
	const paragraphWarnings = checkParagraphSpacing(markdown, lines);
	warnings.push(...paragraphWarnings);

	return {
		isValid: errors.length === 0,
		errors,
		warnings,
	};
}

/**
 * Check headings have blank lines before and after
 */
function checkHeadingBlankLines(
	_markdown: string,
	lines: string[],
): FormattingError[] {
	const errors: FormattingError[] = [];
	const headingRegex = /^(#{1,6})\s+(.+)$/;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(headingRegex);

		if (match) {
			// Check blank line before (except for first line)
			if (i > 0 && lines[i - 1].trim().length > 0) {
				errors.push({
					type: "blank_line",
					severity: "error",
					message: `Heading "${match[2]}" missing blank line before`,
					line: i + 1,
					suggestion: "Add a blank line before this heading",
				});
			}

			// Check blank line after
			if (i < lines.length - 1 && lines[i + 1].trim().length > 0) {
				errors.push({
					type: "blank_line",
					severity: "error",
					message: `Heading "${match[2]}" missing blank line after`,
					line: i + 1,
					suggestion: "Add a blank line after this heading",
				});
			}
		}
	}

	return errors;
}

/**
 * Check table formatting
 */
function checkTableFormatting(
	_markdown: string,
	lines: string[],
): FormattingError[] {
	const errors: FormattingError[] = [];
	let inTable = false;
	let headerColumns = 0;
	let tableStartLine = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const isTableRow =
			line.trim().startsWith("|") && line.trim().endsWith("|");

		if (isTableRow && !inTable) {
			// Start of table
			inTable = true;
			tableStartLine = i + 1;
			headerColumns = (line.match(/\|/g) || []).length - 1;
		} else if (isTableRow && inTable) {
			// Table row
			const columns = (line.match(/\|/g) || []).length - 1;
			if (columns !== headerColumns) {
				errors.push({
					type: "table",
					severity: "error",
					message: `Table row has ${columns} columns, expected ${headerColumns}`,
					line: i + 1,
					suggestion:
						"Ensure all table rows have the same number of columns",
				});
			}

			// Check for separator row
			const isSeparator = /^\|\s*[-:]+\s*\|/.test(line);
			if (isSeparator && i === tableStartLine) {
				errors.push({
					type: "table",
					severity: "error",
					message: "Table separator row should come after header row",
					line: i + 1,
					suggestion: "Add a header row before the separator",
				});
			}
		} else if (inTable && line.trim().length === 0) {
			// Blank line ends table
			inTable = false;
		} else if (inTable && !isTableRow) {
			// Non-table line ends table
			inTable = false;
		}
	}

	return errors;
}

/**
 * Check code blocks are properly closed
 */
function checkCodeBlocks(
	_markdown: string,
	lines: string[],
): FormattingError[] {
	const errors: FormattingError[] = [];
	let inCodeBlock = false;
	let codeBlockStartLine = 0;
	let codeBlockLanguage = "";

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const isCodeBlockStart = /^```/.test(line);
		const isCodeBlockEnd = /^```\s*$/.test(line);

		if (isCodeBlockStart && !inCodeBlock) {
			inCodeBlock = true;
			codeBlockStartLine = i + 1;
			codeBlockLanguage = line.replace(/```/, "").trim();
		} else if (isCodeBlockEnd && inCodeBlock) {
			inCodeBlock = false;
		}
	}

	if (inCodeBlock) {
		errors.push({
			type: "code_block",
			severity: "error",
			message: `Unclosed code block starting at line ${codeBlockStartLine}${codeBlockLanguage ? ` (language: ${codeBlockLanguage})` : ""}`,
			line: codeBlockStartLine,
			suggestion: "Close the code block with ```",
		});
	}

	return errors;
}

/**
 * Check list consistency
 */
function checkListConsistency(
	_markdown: string,
	lines: string[],
): FormattingError[] {
	const warnings: FormattingError[] = [];
	let inList = false;
	let listType: "unordered" | "ordered" | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const isUnorderedItem = /^\s*[-*]\s/.test(line);
		const isOrderedItem = /^\s*\d+\.\s/.test(line);
		const isEmpty = line.trim().length === 0;

		if ((isUnorderedItem || isOrderedItem) && !inList) {
			// Start of list
			inList = true;
			listType = isUnorderedItem ? "unordered" : "ordered";
		} else if (isUnorderedItem && inList && listType === "ordered") {
			// Mixed list types
			warnings.push({
				type: "list",
				severity: "warning",
				message: "Mixed list types: unordered item in ordered list",
				line: i + 1,
				suggestion: "Use consistent list markers within each list",
			});
		} else if (isOrderedItem && inList && listType === "unordered") {
			// Mixed list types
			warnings.push({
				type: "list",
				severity: "warning",
				message: "Mixed list types: ordered item in unordered list",
				line: i + 1,
				suggestion: "Use consistent list markers within each list",
			});
		} else if (isEmpty && inList) {
			// Blank line might end list (or be spacing)
			// Check if next non-empty line is also a list item
			let j = i + 1;
			while (j < lines.length && lines[j].trim().length === 0) {
				j++;
			}
			if (j >= lines.length || (!isUnorderedItem && !isOrderedItem)) {
				inList = false;
				listType = null;
			}
		}
	}

	return warnings;
}

/**
 * Check paragraph spacing
 */
function checkParagraphSpacing(
	_markdown: string,
	lines: string[],
): FormattingError[] {
	const warnings: FormattingError[] = [];

	for (let i = 1; i < lines.length - 1; i++) {
		const prevLine = lines[i - 1];
		const currLine = lines[i];
		const nextLine = lines[i + 1];

		// Check if current line is a paragraph (not heading, list, table, code block)
		const isParagraph =
			currLine.trim().length > 0 &&
			!currLine.match(/^(#{1,6})\s/) && // Not heading
			!currLine.match(/^\s*[-*]\s/) && // Not unordered list
			!currLine.match(/^\s*\d+\.\s/) && // Not ordered list
			!currLine.match(/^\|/) && // Not table
			!currLine.match(/^```/) && // Not code block
			!currLine.match(/^---/) && // Not horizontal rule
			prevLine.trim().length > 0 && // Previous line not empty
			nextLine.trim().length > 0; // Next line not empty

		if (
			isParagraph &&
			prevLine.trim().length > 0 &&
			!prevLine.match(/^```/)
		) {
			// Paragraph without blank line before
			warnings.push({
				type: "paragraph",
				severity: "warning",
				message: "Paragraph should be separated by blank line",
				line: i + 1,
				suggestion: "Add a blank line before this paragraph",
			});
		}
	}

	return warnings;
}
