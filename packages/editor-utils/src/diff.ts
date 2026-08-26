/**
 * Diff utilities for tracking document changes
 * Matches ag-ui-demo implementation exactly
 */

import { diffWords } from "diff";

/**
 * Generate diff markup between two text versions
 * Additions are wrapped in <em> tags (green highlight)
 * Removals are wrapped in <s> tags (red strikethrough)
 *
 * This matches the ag-ui-demo reference implementation exactly.
 * Note: markdown italics will also appear green - same trade-off as reference.
 *
 * Strategy:
 * 1. During streaming (isComplete=false), truncate oldText to match newText length
 *    to avoid marking trailing content as removed prematurely
 * 2. When complete (isComplete=true), compare full texts and mark ALL differences
 * 3. Wrap additions in <em> tags and deletions in <s> tags
 */
export function diffPartialText(
	oldText: string,
	newText: string,
	isComplete = false,
): string {
	// Handle empty cases - for first doc, don't highlight
	if (!oldText || oldText.trim().length === 0) {
		return newText;
	}

	if (!newText || newText.trim().length === 0) {
		return `<s>${oldText}</s>`;
	}

	// If texts are identical, return without highlighting
	if (oldText === newText) {
		return newText;
	}

	let oldTextToCompare = oldText;
	let trailingOldContent = "";

	if (oldText.length > newText.length && !isComplete) {
		// Make oldText shorter to match newText length for partial streaming
		oldTextToCompare = oldText.slice(0, newText.length);
		trailingOldContent = oldText.slice(newText.length);
	}

	const changes = diffWords(oldTextToCompare, newText);

	let result = "";
	for (const part of changes) {
		if (part.added) {
			// Use <em> for additions (green) - matches ag-ui-demo
			result += `<em>${part.value}</em>`;
		} else if (part.removed) {
			// Use <s> for deletions (red strikethrough) - matches ag-ui-demo
			result += `<s>${part.value}</s>`;
		} else {
			result += part.value;
		}
	}

	// Handle trailing old content that wasn't compared
	if (trailingOldContent.length > 0) {
		if (!isComplete) {
			// During streaming: show trailing content as unchanged (gray)
			result += trailingOldContent;
		} else {
			// When complete: mark as removed
			result += `<s>${trailingOldContent}</s>`;
		}
	}

	// CRITICAL FIX: When isComplete=true and oldText is longer than newText,
	// verify that ALL trailing content from oldText is properly marked as removed.
	// The diffWords algorithm may not always capture trailing deletions correctly.
	if (isComplete && oldText.length > newText.length) {
		// Get the removed content from the result
		const removedMatches = result.match(/<s>([\s\S]*?)<\/s>/g) || [];
		let totalRemovedContent = "";
		for (const match of removedMatches) {
			totalRemovedContent += match
				.replace(/<s>/g, "")
				.replace(/<\/s>/g, "");
		}

		// Get unchanged content (parts that weren't added or removed)
		let unchangedContent = "";
		for (const part of changes) {
			if (!part.added && !part.removed) {
				unchangedContent += part.value;
			}
		}

		// The full old text should be: unchanged + removed
		// If unchanged + removed < oldText, there's missing removed content
		const accountedOldContent =
			unchangedContent.length + totalRemovedContent.length;

		if (accountedOldContent < oldText.length) {
			// Find what's missing - it's trailing content from oldText
			const missingLength = oldText.length - accountedOldContent;
			const missingContent = oldText.slice(-missingLength);

			if (missingContent.trim().length > 0) {
				result += `<s>${missingContent}</s>`;
			}
		}
	}

	return result;
}

/**
 * Strip diff markup from text (removes <em> and <s> tags used for diffs)
 * Matches ag-ui-demo implementation
 * Handles tags with or without attributes
 */
export function stripDiffMarkup(text: string | undefined): string {
	if (!text) {
		return "";
	}
	return text
		.replace(/<em[^>]*>/gi, "")
		.replace(/<\/em>/gi, "")
		.replace(/<s[^>]*>/gi, "")
		.replace(/<\/s>/gi, "");
}
