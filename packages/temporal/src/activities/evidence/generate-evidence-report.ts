/**
 * Evidence Report Generation Activity
 *
 * Generates an Evidence.dev dashboard from Fabric report data.
 * This activity:
 * 1. Generates an Evidence project from template + data
 * 2. Optionally builds it using Docker
 * 3. Returns the HTML content for artifact storage
 */

import {
	buildEvidenceProject,
	cleanupProject,
	type AiAnalysisResult as EvidenceAiAnalysisResult,
	type DataSourceResult as EvidenceDataSourceResult,
	type EvidenceTheme,
	type FabricTemplateDefinition,
	type GeneratorInput,
	generateEvidenceProject,
	getProjectSummary,
	isDockerAvailable,
	packageAsInlineHtml,
} from "@repo/evidence";
import { logger } from "@repo/logs";

// =============================================================================
// Types
// =============================================================================

export interface GenerateEvidenceReportInput {
	executionId: string;
	template: {
		id: string;
		name: string;
		description?: string | null;
		templateType: string;
		definition: unknown;
		outputFormat: string;
		fabricConfig?: unknown;
		evidenceProjectId?: string | null;
		evidenceReportSlug?: string | null;
	};
	dataResults: Array<{
		sourceId: string;
		sourceType: string;
		data: unknown;
		error?: string;
	}>;
	aiResults: Array<{
		agentId: string;
		task: string;
		output: string;
		outputVariable?: string;
		error?: string;
	}>;
	parameters: Record<string, unknown>;
	dateRange?: {
		start: string;
		end: string;
		period?: string;
	};
	evidenceConfig?: {
		theme?: EvidenceTheme;
		layout?: {
			sidebar?: boolean;
			header?: boolean;
		};
		useDocker?: boolean;
	};
}

export interface GenerateEvidenceReportOutput {
	success: boolean;
	htmlContent?: string;
	projectDir?: string;
	buildDuration?: number;
	error?: string;
	warnings?: string[];
}

// =============================================================================
// Main Activity
// =============================================================================

/**
 * Generate an Evidence report from Fabric template and data
 */
export async function generateEvidenceReport(
	input: GenerateEvidenceReportInput,
): Promise<GenerateEvidenceReportOutput> {
	const startTime = Date.now();

	logger.info("[Evidence] Starting report generation", {
		executionId: input.executionId,
		templateName: input.template.name,
		dataSourceCount: input.dataResults.length,
		aiResultCount: input.aiResults.length,
	});

	let projectDir: string | undefined;

	try {
		// 1. Map input types to Evidence types
		const generatorInput: GeneratorInput = {
			template: {
				id: input.template.id,
				name: input.template.name,
				description: input.template.description,
				templateType: input.template.templateType,
				definition: input.template
					.definition as FabricTemplateDefinition,
				outputFormat: input.template.outputFormat,
				fabricConfig: input.template
					.fabricConfig as GeneratorInput["template"]["fabricConfig"],
				evidenceProjectId: input.template.evidenceProjectId,
				evidenceReportSlug: input.template.evidenceReportSlug,
			},
			dataResults: mapDataResults(input.dataResults),
			aiResults: mapAiResults(input.aiResults),
			parameters: input.parameters,
			dateRange: input.dateRange as GeneratorInput["dateRange"],
			evidenceOverrides: input.evidenceConfig
				? {
						theme: input.evidenceConfig.theme,
						layout: input.evidenceConfig.layout,
					}
				: undefined,
		};

		// 2. Generate Evidence project
		logger.info("[Evidence] Generating Evidence project...");
		const projectOutput = await generateEvidenceProject(generatorInput);
		projectDir = projectOutput.projectDir;

		logger.info("[Evidence] Project generated", {
			projectDir,
			fileCount: projectOutput.files.length,
			summary: getProjectSummary(projectOutput),
		});

		// 3. Check if we should build with Docker
		const useDocker = input.evidenceConfig?.useDocker ?? true;
		const dockerAvailable = useDocker && (await isDockerAvailable());

		if (dockerAvailable) {
			// Build with Docker
			logger.info("[Evidence] Building with Docker...");

			const outputDir = `${projectDir}-build`;
			const buildResult = await buildEvidenceProject({
				projectDir,
				outputDir,
				timeout: 5 * 60 * 1000, // 5 minutes
			});

			if (buildResult.success) {
				// Package as inline HTML
				const htmlContent = await packageAsInlineHtml(outputDir);

				if (htmlContent) {
					const duration = Date.now() - startTime;

					logger.info("[Evidence] Report generated successfully", {
						executionId: input.executionId,
						duration,
						htmlSize: htmlContent.length,
					});

					// Cleanup
					await cleanupProject(projectDir);
					await cleanupProject(outputDir);

					return {
						success: true,
						htmlContent,
						buildDuration: buildResult.duration,
						warnings: projectOutput.warnings,
					};
				}

				return {
					success: false,
					error: "Failed to package built output as HTML",
					warnings: projectOutput.warnings,
				};
			}

			logger.warn(
				"[Evidence] Docker build failed, falling back to project-only mode",
				{
					error: buildResult.error,
				},
			);
		}

		// 4. Fallback: Generate static HTML from markdown without Evidence build
		// This provides a simpler output when Docker is not available
		logger.info("[Evidence] Generating fallback HTML (no Docker build)...");

		const fallbackHtml = await generateFallbackHtml(
			generatorInput,
			projectOutput,
		);

		const duration = Date.now() - startTime;

		// Cleanup project directory
		await cleanupProject(projectDir);

		return {
			success: true,
			htmlContent: fallbackHtml,
			buildDuration: duration,
			warnings: [
				...(projectOutput.warnings || []),
				"Generated without Evidence build (Docker not available). Some interactive features may be limited.",
			],
		};
	} catch (error) {
		const duration = Date.now() - startTime;
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		logger.error("[Evidence] Report generation failed", {
			executionId: input.executionId,
			error: errorMessage,
			duration,
		});

		// Cleanup on error
		if (projectDir) {
			try {
				await cleanupProject(projectDir);
			} catch {
				// Ignore cleanup errors
			}
		}

		return {
			success: false,
			error: errorMessage,
			buildDuration: duration,
		};
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Map Temporal data results to Evidence data source results
 */
function mapDataResults(
	results: GenerateEvidenceReportInput["dataResults"],
): EvidenceDataSourceResult[] {
	return results.map((r) => ({
		sourceId: r.sourceId,
		sourceType: r.sourceType,
		data: Array.isArray(r.data) ? r.data : r.data ? [r.data] : [],
		error: r.error,
	}));
}

/**
 * Map Temporal AI results to Evidence AI results
 */
function mapAiResults(
	results: GenerateEvidenceReportInput["aiResults"],
): EvidenceAiAnalysisResult[] {
	return results.map((r) => ({
		agentId: r.agentId,
		outputVariable: r.outputVariable || r.agentId,
		content: r.output,
		error: r.error,
	}));
}

/**
 * Generate fallback HTML when Docker build is not available
 * Creates a simple but well-styled HTML document from the data
 */
async function generateFallbackHtml(
	input: GeneratorInput,
	projectOutput: {
		projectDir: string;
		files: Array<{ path: string; type: string }>;
	},
): Promise<string> {
	const fs = await import("node:fs/promises");
	const path = await import("node:path");

	// Read the generated index.md page
	const indexPath = path.join(projectOutput.projectDir, "pages", "index.md");
	let markdownContent = "";

	try {
		const content = await fs.readFile(indexPath, "utf-8");
		// Remove frontmatter
		markdownContent = content.replace(/^---[\s\S]*?---\n\n/, "");
	} catch {
		markdownContent = `# ${input.template.name}\n\nReport generated at ${new Date().toISOString()}`;
	}

	// Simple markdown to HTML conversion (basic)
	const htmlContent = convertMarkdownToHtml(markdownContent);

	// Get theme colors
	const theme = input.evidenceOverrides?.theme;
	const primaryColor = theme?.colors?.primary || "#2563eb";
	const textColor = theme?.colors?.text || "#1e293b";
	const bgColor = theme?.colors?.background || "#ffffff";

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${escapeHtml(input.template.name)}</title>
	<style>
		:root {
			--primary: ${primaryColor};
			--text: ${textColor};
			--bg: ${bgColor};
		}

		* {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}

		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
			line-height: 1.6;
			color: var(--text);
			background: var(--bg);
			padding: 2rem;
			max-width: 900px;
			margin: 0 auto;
		}

		h1, h2, h3, h4 {
			margin-top: 1.5em;
			margin-bottom: 0.5em;
			font-weight: 600;
		}

		h1 { font-size: 2rem; color: var(--primary); }
		h2 { font-size: 1.5rem; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.5rem; }
		h3 { font-size: 1.25rem; }

		p { margin-bottom: 1rem; }

		table {
			width: 100%;
			border-collapse: collapse;
			margin: 1rem 0;
			font-size: 0.9rem;
		}

		th, td {
			border: 1px solid #e5e7eb;
			padding: 0.75rem;
			text-align: left;
		}

		th {
			background: #f8fafc;
			font-weight: 600;
		}

		tr:hover {
			background: #f8fafc;
		}

		code {
			background: #f1f5f9;
			padding: 0.2em 0.4em;
			border-radius: 4px;
			font-size: 0.9em;
		}

		pre {
			background: #f8fafc;
			padding: 1rem;
			border-radius: 8px;
			overflow-x: auto;
			margin: 1rem 0;
		}

		pre code {
			background: none;
			padding: 0;
		}

		blockquote {
			border-left: 4px solid var(--primary);
			padding-left: 1rem;
			margin: 1rem 0;
			color: #64748b;
		}

		hr {
			border: none;
			border-top: 1px solid #e5e7eb;
			margin: 2rem 0;
		}

		.metadata {
			color: #64748b;
			font-size: 0.9rem;
			margin-bottom: 1rem;
		}

		.footer {
			margin-top: 3rem;
			padding-top: 1rem;
			border-top: 1px solid #e5e7eb;
			font-size: 0.875rem;
			color: #64748b;
		}

		.evidence-note {
			background: #fef3c7;
			border: 1px solid #f59e0b;
			border-radius: 8px;
			padding: 1rem;
			margin: 1rem 0;
			font-size: 0.9rem;
		}
	</style>
</head>
<body>
	${htmlContent}

	<div class="footer">
		<p>Generated by Fabric Reports · ${new Date().toLocaleString()}</p>
	</div>
</body>
</html>`;
}

/**
 * Basic markdown to HTML conversion
 * Note: This is a simplified converter for fallback mode
 */
function convertMarkdownToHtml(markdown: string): string {
	let html = markdown;

	// Headers
	html = html.replace(/^### (.*$)/gim, "<h3>$1</h3>");
	html = html.replace(/^## (.*$)/gim, "<h2>$1</h2>");
	html = html.replace(/^# (.*$)/gim, "<h1>$1</h1>");

	// Bold and italic
	html = html.replace(/\*\*\*(.*?)\*\*\*/g, "<strong><em>$1</em></strong>");
	html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");
	html = html.replace(/_(.*?)_/g, "<em>$1</em>");

	// Code blocks
	html = html.replace(
		/```(\w*)\n([\s\S]*?)```/g,
		"<pre><code>$2</code></pre>",
	);

	// Inline code
	html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

	// Blockquotes
	html = html.replace(/^> (.*$)/gim, "<blockquote>$1</blockquote>");

	// Horizontal rules
	html = html.replace(/^---$/gim, "<hr>");

	// Lists (simple)
	html = html.replace(/^\s*[-*] (.*$)/gim, "<li>$1</li>");

	// Paragraphs (wrap remaining lines)
	html = html
		.split("\n\n")
		.map((block) => {
			if (
				block.startsWith("<h") ||
				block.startsWith("<pre") ||
				block.startsWith("<blockquote") ||
				block.startsWith("<hr") ||
				block.startsWith("<li") ||
				block.startsWith("<table")
			) {
				return block;
			}
			if (block.trim()) {
				return `<p>${block.replace(/\n/g, "<br>")}</p>`;
			}
			return "";
		})
		.join("\n");

	// Wrap consecutive li elements in ul
	html = html.replace(/(<li>.*?<\/li>\n?)+/g, "<ul>$&</ul>");

	return html;
}

/**
 * Escape HTML entities
 */
function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
