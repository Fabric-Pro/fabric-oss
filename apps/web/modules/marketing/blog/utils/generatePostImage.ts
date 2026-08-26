/**
 * Generates a unique SVG image for a blog post based on its tags and title
 * Returns a data URI that can be used as an image src
 */
export function generatePostImage(title: string, tags: string[]): string {
	// Generate a hash from the title to ensure consistency
	const hash = hashString(title);

	// Pick colors based on the first tag or use default
	const colorScheme = getColorSchemeForTags(tags, hash);

	// Generate SVG
	const svg = `
		<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
			<defs>
				<linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" style="stop-color:${colorScheme.start};stop-opacity:1" />
					<stop offset="100%" style="stop-color:${colorScheme.end};stop-opacity:1" />
				</linearGradient>
				<pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
					<circle cx="20" cy="20" r="1.5" fill="white" opacity="0.1"/>
				</pattern>
			</defs>

			<!-- Background gradient -->
			<rect width="1200" height="630" fill="url(#grad)"/>

			<!-- Pattern overlay -->
			<rect width="1200" height="630" fill="url(#grid)"/>

			<!-- Decorative shapes -->
			<circle cx="${100 + (hash % 200)}" cy="${100 + ((hash * 2) % 200)}" r="80" fill="white" opacity="0.05"/>
			<circle cx="${1000 - (hash % 200)}" cy="${500 - ((hash * 3) % 200)}" r="120" fill="white" opacity="0.05"/>

			<!-- Title -->
			<g transform="translate(60, 240)">
				${wrapText(title, 32, 900)
					.map(
						(line, i) => `
					<text x="0" y="${i * 70}" font-family="system-ui, -apple-system, sans-serif" font-size="56" font-weight="bold" fill="white">${escapeXml(line)}</text>
				`,
					)
					.join("")}
			</g>

			<!-- Bottom accent -->
			<rect x="0" y="610" width="1200" height="20" fill="white" opacity="0.1"/>
		</svg>
	`.trim();

	// Convert to data URI
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * Simple string hash function
 */
function hashString(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash; // Convert to 32bit integer
	}
	return Math.abs(hash);
}

/**
 * Get color scheme based on tags
 */
function getColorSchemeForTags(
	tags: string[],
	hash: number,
): { start: string; end: string } {
	const schemes: Record<string, { start: string; end: string }> = {
		AI: { start: "#667eea", end: "#764ba2" },
		RAG: { start: "#f093fb", end: "#f5576c" },
		SDLC: { start: "#4facfe", end: "#00f2fe" },
		Enterprise: { start: "#43e97b", end: "#38f9d7" },
		Automation: { start: "#fa709a", end: "#fee140" },
		"Document Intelligence": { start: "#30cfd0", end: "#330867" },
		Technical: { start: "#a8edea", end: "#fed6e3" },
		Architecture: { start: "#ff9a9e", end: "#fecfef" },
		Vector: { start: "#ffecd2", end: "#fcb69f" },
		Database: { start: "#ff6e7f", end: "#bfe9ff" },
	};

	// Find matching tag
	for (const tag of tags) {
		if (schemes[tag]) {
			return schemes[tag];
		}
	}

	// Default gradient based on hash
	const defaultSchemes = [
		{ start: "#667eea", end: "#764ba2" },
		{ start: "#f093fb", end: "#f5576c" },
		{ start: "#4facfe", end: "#00f2fe" },
		{ start: "#43e97b", end: "#38f9d7" },
		{ start: "#fa709a", end: "#fee140" },
	];

	return defaultSchemes[hash % defaultSchemes.length];
}

/**
 * Wrap text to fit within a specified width
 */
function wrapText(
	text: string,
	maxCharsPerLine: number,
	_maxWidth: number,
): string[] {
	const words = text.split(" ");
	const lines: string[] = [];
	let currentLine = "";

	for (const word of words) {
		const testLine = currentLine ? `${currentLine} ${word}` : word;

		if (testLine.length <= maxCharsPerLine) {
			currentLine = testLine;
		} else {
			if (currentLine) {
				lines.push(currentLine);
			}
			currentLine = word;
		}
	}

	if (currentLine) {
		lines.push(currentLine);
	}

	// Limit to 3 lines
	return lines.slice(0, 3);
}

/**
 * Escape XML special characters
 */
function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
