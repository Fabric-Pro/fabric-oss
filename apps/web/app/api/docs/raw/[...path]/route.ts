import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "@repo/config";
import { getBaseUrl } from "@repo/utils";
import { type NextRequest, NextResponse } from "next/server";

/**
 * API route that serves raw markdown content for documentation pages.
 * This enables curl-friendly documentation access:
 *
 * ```bash
 * curl -s https://fabric.pro/en/docs -H 'accept: text/markdown' | glow
 * ```
 *
 * The middleware intercepts requests with `Accept: text/markdown` header
 * and rewrites them to this API route.
 */
export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ path: string[] }> },
) {
	const { path: pathSegments } = await params;

	// First segment is the locale
	const locale = pathSegments[0] || config.i18n.defaultLocale;
	const docPath = pathSegments.slice(1);

	// Construct the file path
	const contentDir = path.join(process.cwd(), "content", "docs");

	// Try different file paths (with locale suffix, without, index files)
	const possiblePaths = getPossibleFilePaths(contentDir, docPath, locale);

	let filePath: string | null = null;
	let content: string | null = null;

	for (const possiblePath of possiblePaths) {
		try {
			content = await fs.readFile(possiblePath, "utf-8");
			filePath = possiblePath;
			break;
		} catch {
			// Try next path
		}
	}

	if (!content || !filePath) {
		return NextResponse.json(
			{
				error: "Document not found",
				path: docPath.join("/"),
				locale,
			},
			{ status: 404 },
		);
	}

	// Process the markdown content
	const processedContent = processMarkdownForCurl(content, locale);

	return new NextResponse(processedContent, {
		status: 200,
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			"Cache-Control": "public, max-age=3600, s-maxage=86400",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

/**
 * Generate possible file paths for a documentation page.
 * Handles index files and locale-specific content.
 */
function getPossibleFilePaths(
	contentDir: string,
	docPath: string[],
	locale: string,
): string[] {
	const defaultLocale = config.i18n.defaultLocale;
	const basePath = docPath.join("/");
	const paths: string[] = [];

	if (docPath.length === 0 || basePath === "") {
		// Root docs page
		if (locale !== defaultLocale) {
			paths.push(path.join(contentDir, `index.${locale}.mdx`));
		}
		paths.push(path.join(contentDir, "index.mdx"));
	} else {
		// Specific doc page
		if (locale !== defaultLocale) {
			// Try locale-specific file first
			paths.push(path.join(contentDir, `${basePath}.${locale}.mdx`));
			paths.push(path.join(contentDir, basePath, `index.${locale}.mdx`));
		}
		// Try default file
		paths.push(path.join(contentDir, `${basePath}.mdx`));
		paths.push(path.join(contentDir, basePath, "index.mdx"));
	}

	return paths;
}

/**
 * Process MDX content for curl output.
 * - Strips frontmatter but extracts title/description
 * - Converts fumadocs components to readable markdown
 * - Formats links with URL context
 */
function processMarkdownForCurl(content: string, locale: string): string {
	// Extract frontmatter
	const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
	let body = content;
	let title = "";
	let description = "";

	if (frontmatterMatch) {
		const frontmatter = frontmatterMatch[1];
		body = content.slice(frontmatterMatch[0].length);

		// Parse title and description from frontmatter
		const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
		const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

		if (titleMatch) {
			title = titleMatch[1].trim();
		}
		if (descMatch) {
			description = descMatch[1].trim();
		}
	}

	// Build the output
	let output = "";

	if (title) {
		output += `# ${title}\n\n`;
	}

	if (description) {
		output += `${description}\n\n`;
	}

	// Process the body
	let processedBody = body;

	// Convert fumadocs Card components to markdown links
	processedBody = processedBody.replace(
		/<Card\s+title="([^"]+)"\s+href="([^"]+)"[^>]*>\s*([\s\S]*?)\s*<\/Card>/g,
		(_match, cardTitle, href, cardContent) => {
			const cleanContent = cardContent.trim().replace(/\n\s*/g, " ");
			return `- **[${cardTitle}](${href})** - ${cleanContent}`;
		},
	);

	// Convert Cards wrapper to nothing (just keep the contents)
	processedBody = processedBody.replace(/<\/?Cards>/g, "");

	// Convert Steps/Step components to numbered list
	let stepNumber = 0;
	processedBody = processedBody.replace(
		/<Step>\s*([\s\S]*?)\s*<\/Step>/g,
		(_match, stepContent) => {
			stepNumber++;
			// Clean up the step content - remove ### headers and format nicely
			let cleaned = stepContent.trim();
			cleaned = cleaned.replace(/^###\s*/, `${stepNumber}. **`);
			// Find the end of the header line and close the bold
			cleaned = cleaned.replace(/\n/, "**\n   ");
			// Indent subsequent lines
			cleaned = cleaned.replace(/\n(?!\s*$)/g, "\n   ");
			return cleaned;
		},
	);
	processedBody = processedBody.replace(/<\/?Steps>/g, "");

	// Reset step counter for next Steps block
	processedBody = processedBody.replace(/<Steps>/g, () => {
		stepNumber = 0;
		return "";
	});

	// Convert Tab/Tabs to simple sections
	processedBody = processedBody.replace(
		/<Tab\s+value="([^"]+)"[^>]*>([\s\S]*?)<\/Tab>/g,
		(_match, tabName, tabContent) => {
			return `### ${tabName}\n${tabContent.trim()}\n`;
		},
	);
	processedBody = processedBody.replace(/<\/?Tabs[^>]*>/g, "");

	// Remove import statements
	processedBody = processedBody.replace(
		/^import\s+.*?from\s+["'].*?["'];?\s*$/gm,
		"",
	);

	// Clean up excessive newlines
	processedBody = processedBody.replace(/\n{3,}/g, "\n\n");

	output += processedBody.trim();

	// Add footer with web link (deployment's own base URL, not hardcoded)
	const baseUrl = getBaseUrl();
	output += `\n\n---\n📖 View this documentation at ${baseUrl}/${locale}/docs\n`;

	return output;
}
