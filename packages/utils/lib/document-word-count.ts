/**
 * Count meaningful prose words in document content.
 * Strips mermaid blocks, code blocks, image references, and base64 data URLs
 * before counting so that non-prose content does not inflate the word count.
 *
 * A generation run's save, an editor save, a rejected regeneration's rewind
 * and a restore all count a project document's `wordCount` with this one, so
 * a body counts the same whichever of them wrote it (Fizzy #2946).
 */
export function countDocumentWords(content: string): number {
	let cleaned = content;
	// 1. Strip fenced code blocks (including mermaid diagrams)
	cleaned = cleaned.replace(/```[\s\S]*?```/g, "");
	// 2. Strip image references: ![alt](src) and HTML <img> tags
	cleaned = cleaned.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
	cleaned = cleaned.replace(/<img\s[^>]*\/>/g, "");
	// 3. Strip any remaining base64 data URLs
	cleaned = cleaned.replace(/data:[a-z/]+;base64,[A-Za-z0-9+/=]+/g, "");
	// 4. Split on whitespace and count non-empty tokens
	return cleaned.split(/\s+/).filter((w) => w.length > 0).length;
}
