/**
 * Generic hero image generator for cards across the app
 * Creates beautiful gradient images with title text overlay (blog-style)
 * Each image is unique based on the item's name and category
 */

export type HeroImageOptions = {
	name: string;
	category?: string | null;
	/** Optional custom color scheme override */
	colorScheme?: { start: string; end: string };
};

/**
 * Generates a beautiful SVG gradient hero image with title
 * Returns a data URI that can be used as an image src
 */
export function generateHeroImage(options: HeroImageOptions): string {
	const { name, category, colorScheme } = options;

	// Get color scheme - use provided or derive from category/name
	const colors = colorScheme || getColorSchemeForCategory(category, name);

	// Generate a hash from the name for consistent variation
	const hash = hashString(name);

	// Create unique IDs for SVG elements to avoid conflicts
	const uniqueId = `hero-${hash}`;
	const gradId = `grad-${uniqueId}`;
	const dotsId = `dots-${uniqueId}`;

	// Decorative circle positions (vary by hash)
	const circle1X = 80 + (hash % 150);
	const circle1Y = 80 + ((hash * 2) % 120);
	const circle2X = 1000 - (hash % 200);
	const circle2Y = 450 - ((hash * 3) % 150);
	const circle3X = 600 + ((hash * 5) % 300);
	const circle3Y = 100 + ((hash * 7) % 200);

	// Wrap title text
	const titleLines = wrapText(name, 28, 1000);

	// Calculate title Y position to center vertically
	const lineHeight = 65;
	const totalTextHeight = titleLines.length * lineHeight;
	const startY = (675 - totalTextHeight) / 2 + 40;

	// Generate SVG with gradient background and title overlay
	const svg = `
		<svg width="1200" height="675" xmlns="http://www.w3.org/2000/svg">
			<defs>
				<linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" style="stop-color:${colors.start};stop-opacity:1" />
					<stop offset="100%" style="stop-color:${colors.end};stop-opacity:1" />
				</linearGradient>
				<pattern id="${dotsId}" width="40" height="40" patternUnits="userSpaceOnUse">
					<circle cx="20" cy="20" r="1.5" fill="white" opacity="0.08"/>
				</pattern>
			</defs>

			<!-- Background gradient -->
			<rect width="1200" height="675" fill="url(#${gradId})"/>

			<!-- Dot pattern overlay -->
			<rect width="1200" height="675" fill="url(#${dotsId})"/>

			<!-- Decorative shapes for depth -->
			<circle cx="${circle1X}" cy="${circle1Y}" r="${70 + (hash % 40)}" fill="white" opacity="0.06"/>
			<circle cx="${circle2X}" cy="${circle2Y}" r="${90 + ((hash * 2) % 50)}" fill="white" opacity="0.04"/>
			<circle cx="${circle3X}" cy="${circle3Y}" r="${50 + ((hash * 3) % 30)}" fill="white" opacity="0.05"/>

			<!-- Title text -->
			<g transform="translate(60, ${startY})">
				${titleLines
					.map(
						(line, i) => `
					<text x="0" y="${i * lineHeight}" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="52" font-weight="bold" fill="white">${escapeXml(line)}</text>
				`,
					)
					.join("")}
			</g>

			<!-- Bottom accent bar -->
			<rect x="0" y="655" width="1200" height="20" fill="white" opacity="0.08"/>
		</svg>
	`.trim();

	// Convert to data URI
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * Get gradient color scheme based on category
 * Falls back to hash-based unique colors if category doesn't match
 */
function getColorSchemeForCategory(
	category: string | null | undefined,
	name: string,
): { start: string; end: string } {
	const schemes: Record<string, { start: string; end: string }> = {
		// Prompts - Warm tones
		Explore: { start: "#667eea", end: "#764ba2" }, // Purple
		Automate: { start: "#fa709a", end: "#fee140" }, // Pink to Yellow
		Create: { start: "#f093fb", end: "#f5576c" }, // Magenta to Coral
		Deploy: { start: "#43e97b", end: "#38f9d7" }, // Green to Cyan
		Research: { start: "#4facfe", end: "#00f2fe" }, // Blue to Cyan
		Documentation: { start: "#ff9a9e", end: "#fecfef" }, // Soft Pink
		Planning: { start: "#a18cd1", end: "#fbc2eb" }, // Lavender to Pink
		Quality: { start: "#30cfd0", end: "#330867" }, // Teal to Purple
		Onboarding: { start: "#43e97b", end: "#38f9d7" }, // Fresh Green
		Development: { start: "#667eea", end: "#764ba2" }, // Developer Purple
		Testing: { start: "#ffecd2", end: "#fcb69f" }, // Peach
		Analytics: { start: "#4facfe", end: "#00f2fe" }, // Data Blue

		// AI Agents - Vibrant tech gradients
		"Document Generation": { start: "#f093fb", end: "#f5576c" }, // Magenta Burst
		"Code Analysis": { start: "#667eea", end: "#764ba2" }, // Purple Code
		"Task Planning": { start: "#a18cd1", end: "#fbc2eb" }, // Soft Lavender
		"Content Creation": { start: "#fa709a", end: "#fee140" }, // Sunset Glow
		LANGGRAPH: { start: "#667eea", end: "#764ba2" }, // AI Purple
		AUTOGEN: { start: "#4facfe", end: "#00f2fe" }, // Ocean Blue
		CREWAI: { start: "#43e97b", end: "#38f9d7" }, // Fresh Mint
		CUSTOM: { start: "#f093fb", end: "#f5576c" }, // Custom Pink

		// Projects - Vibrant status colors
		DRAFT: { start: "#a18cd1", end: "#fbc2eb" }, // Soft Lavender
		ACTIVE: { start: "#43e97b", end: "#38f9d7" }, // Fresh Mint
		COMPLETED: { start: "#4facfe", end: "#00f2fe" }, // Ocean Blue
		ARCHIVED: { start: "#ffecd2", end: "#fcb69f" }, // Warm Peach

		// Workflows - Vibrant status colors
		PUBLISHED: { start: "#43e97b", end: "#38f9d7" }, // Success Green
		PAUSED: { start: "#ffecd2", end: "#fcb69f" }, // Warm Amber

		// Workflow trigger types - Distinct colors for variety
		MANUAL: { start: "#667eea", end: "#764ba2" }, // Purple - Manual trigger
		WEBHOOK: { start: "#f093fb", end: "#f5576c" }, // Magenta - Webhook trigger
		SCHEDULE: { start: "#4facfe", end: "#00f2fe" }, // Ocean Blue - Scheduled
		EVENT: { start: "#43e97b", end: "#38f9d7" }, // Fresh Mint - Event-driven

		// MCP Server categories
		"Developer Tools": { start: "#667eea", end: "#764ba2" },
		Data: { start: "#4facfe", end: "#00f2fe" },
		Communication: { start: "#f093fb", end: "#f5576c" },
		"Project Management": { start: "#43e97b", end: "#38f9d7" },
		"MCP Server": { start: "#a18cd1", end: "#fbc2eb" },

		// Additional common categories
		AI: { start: "#667eea", end: "#764ba2" },
		RAG: { start: "#f093fb", end: "#f5576c" },
		SDLC: { start: "#4facfe", end: "#00f2fe" },
		Enterprise: { start: "#43e97b", end: "#38f9d7" },
		Automation: { start: "#fa709a", end: "#fee140" },
		Technical: { start: "#89f7fe", end: "#66a6ff" },
		Architecture: { start: "#ff9a9e", end: "#fecfef" },

		// Agent scopes
		SYSTEM: { start: "#667eea", end: "#764ba2" }, // System Purple
		ORGANIZATION: { start: "#4facfe", end: "#00f2fe" }, // Org Blue
		USER: { start: "#f093fb", end: "#f5576c" }, // Personal Pink
	};

	if (category && schemes[category]) {
		return schemes[category];
	}

	// Generate unique color based on name hash for variety
	const hash = hashString(name);
	return generateColorFromHash(hash);
}

/**
 * Generate a color scheme from a hash to ensure variety
 * These are carefully curated gradient pairs that look great
 */
function generateColorFromHash(hash: number): { start: string; end: string } {
	const colorPalettes = [
		{ start: "#667eea", end: "#764ba2" }, // Purple Dream
		{ start: "#f093fb", end: "#f5576c" }, // Pink Sunset
		{ start: "#4facfe", end: "#00f2fe" }, // Ocean Blue
		{ start: "#43e97b", end: "#38f9d7" }, // Fresh Mint
		{ start: "#fa709a", end: "#fee140" }, // Warm Glow
		{ start: "#30cfd0", end: "#330867" }, // Deep Teal
		{ start: "#a18cd1", end: "#fbc2eb" }, // Soft Lavender
		{ start: "#ff9a9e", end: "#fecfef" }, // Blush Rose
		{ start: "#ffecd2", end: "#fcb69f" }, // Peach Cream
		{ start: "#a8edea", end: "#fed6e3" }, // Cotton Candy
		{ start: "#d299c2", end: "#fef9d7" }, // Pastel Dream
		{ start: "#89f7fe", end: "#66a6ff" }, // Sky Gradient
	];

	// Select palette based on hash
	const paletteIndex = hash % colorPalettes.length;
	return colorPalettes[paletteIndex];
}

/**
 * Simple string hash function for consistent variations
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
 * Wrap text to fit within a specified character limit per line
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

	// Limit to 3 lines max
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
