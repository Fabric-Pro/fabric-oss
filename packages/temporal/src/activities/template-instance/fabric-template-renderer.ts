/**
 * Fabric AI Template Renderer
 *
 * Integrates Fabric AI Server's template plugin system for dynamic content in reports.
 *
 * Fabric Template Plugins supported:
 * - {{plugin:text:uppercase:value}} - Text manipulation
 * - {{plugin:datetime:today}} - Date/time functions
 * - {{plugin:datetime:rel:-7d}} - Relative dates
 * - {{plugin:file:read:path}} - File contents
 * - {{plugin:fetch:get:url}} - HTTP fetching
 * - {{plugin:sys:env:VAR}} - Environment variables
 * - {{plugin:hash:sha256:string}} - Hashing
 *
 * Pattern Integration:
 * - {{pattern:summarize}} - Apply Fabric pattern to section content
 * - {{pattern:extract_wisdom}} - Extract insights
 * - {{pattern:analyze_claims}} - Analyze claims in content
 *
 * Variable Substitution:
 * - {{variable:name}} - User-defined variables
 * - {{input}} - Main input content
 */

import { createFabricClient, type FabricClient } from "@repo/fabric-ai";
import { logger } from "@repo/logs";

export interface TemplateSection {
	id: string;
	title: string;
	type: "static" | "dynamic" | "ai_generated" | "pattern" | "data_source";
	content?: string;
	patternName?: string;
	dataSourceId?: string;
	config?: Record<string, unknown>;
}

export interface RenderContext {
	variables: Record<string, string>;
	dataResults: Record<string, unknown>;
	userId: string;
	organizationId?: string;
}

export interface RenderedSection {
	id: string;
	title: string;
	content: string;
	renderedAt: Date;
	fabricPluginsUsed: boolean;
	patternApplied?: string;
	errors?: string[];
}

/**
 * Render a template section with Fabric AI plugin support
 */
export async function renderTemplateSection(
	section: TemplateSection,
	context: RenderContext,
	fabricClient?: FabricClient,
): Promise<RenderedSection> {
	const errors: string[] = [];
	let content = section.content || "";
	let fabricPluginsUsed = false;
	let patternApplied: string | undefined;

	const client = fabricClient || createFabricClient();

	try {
		// 1. Substitute user variables first
		content = substituteVariables(content, context.variables);

		// 2. Apply Fabric template plugins
		if (containsFabricPlugins(content)) {
			try {
				const pluginResult = await client.applyTemplate(
					content,
					context.variables,
					context.dataResults
						? JSON.stringify(context.dataResults)
						: undefined,
				);
				content = pluginResult.output;
				fabricPluginsUsed = true;
			} catch (error) {
				const msg = `Failed to apply Fabric plugins: ${error instanceof Error ? error.message : "Unknown error"}`;
				logger.warn(msg);
				errors.push(msg);
			}
		}

		// 3. Handle pattern-based sections
		if (section.type === "pattern" && section.patternName) {
			try {
				const patternResult = await client.executePattern({
					input: content,
					pattern: section.patternName,
					variables: context.variables,
				});
				content = patternResult;
				patternApplied = section.patternName;
				fabricPluginsUsed = true;
			} catch (error) {
				const msg = `Failed to apply pattern ${section.patternName}: ${error instanceof Error ? error.message : "Unknown error"}`;
				logger.warn(msg);
				errors.push(msg);
			}
		}

		// 4. Handle inline pattern references {{pattern:name}}
		const patternMatches = content.matchAll(/\{\{pattern:([^}]+)\}\}/g);
		for (const match of patternMatches) {
			const patternName = match[1];
			try {
				// Get content before this pattern marker as input
				const beforePattern = content.substring(0, match.index);
				const afterPattern = content.substring(
					// biome-ignore lint/style/noNonNullAssertion: match.index is always defined on a regex match result
					match.index! + match[0].length,
				);

				// Use the section content as input to the pattern
				const patternInput =
					beforePattern.trim() || section.content || "";
				const patternResult = await client.executePattern({
					input: patternInput,
					pattern: patternName,
					variables: context.variables,
				});

				content = beforePattern + patternResult + afterPattern;
				patternApplied = patternName;
				fabricPluginsUsed = true;
			} catch (error) {
				logger.warn(
					`Failed to apply inline pattern ${patternName}:`,
					error,
				);
				errors.push(`Pattern ${patternName} failed`);
			}
		}

		// 5. Handle data source sections
		if (section.type === "data_source" && section.dataSourceId) {
			const sourceData = context.dataResults[section.dataSourceId];
			if (sourceData) {
				// Format the data based on content type
				const formattedData = formatDataForSection(
					sourceData,
					section.config,
				);
				content = content
					? `${content}\n\n${formattedData}`
					: formattedData;
			} else {
				errors.push(`Data source ${section.dataSourceId} not found`);
			}
		}
	} catch (error) {
		const msg = `Section rendering failed: ${error instanceof Error ? error.message : "Unknown error"}`;
		logger.error(msg);
		errors.push(msg);
	}

	return {
		id: section.id,
		title: section.title,
		content,
		renderedAt: new Date(),
		fabricPluginsUsed,
		patternApplied,
		errors: errors.length > 0 ? errors : undefined,
	};
}

/**
 * Render multiple sections in parallel
 */
export async function renderTemplateSections(
	sections: TemplateSection[],
	context: RenderContext,
): Promise<RenderedSection[]> {
	const client = createFabricClient();

	// Check if Fabric is available
	const fabricAvailable = await client.healthCheck();

	if (!fabricAvailable) {
		logger.warn(
			"Fabric AI Server not available, rendering without plugins",
		);
	}

	// Render sections in parallel (respecting order for dependencies)
	const results = await Promise.all(
		sections.map((section) =>
			renderTemplateSection(
				section,
				context,
				fabricAvailable ? client : undefined,
			),
		),
	);

	return results;
}

/**
 * Expand Fabric datetime plugins for common report date ranges
 */
export function getReportDateVariables(): Record<string, string> {
	const now = new Date();
	const startOfWeek = new Date(now);
	startOfWeek.setDate(now.getDate() - now.getDay());

	const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
	const startOfQuarter = new Date(
		now.getFullYear(),
		Math.floor(now.getMonth() / 3) * 3,
		1,
	);
	const startOfYear = new Date(now.getFullYear(), 0, 1);

	return {
		TODAY: now.toISOString().split("T")[0],
		NOW: now.toISOString(),
		WEEK_START: startOfWeek.toISOString().split("T")[0],
		MONTH_START: startOfMonth.toISOString().split("T")[0],
		QUARTER_START: startOfQuarter.toISOString().split("T")[0],
		YEAR_START: startOfYear.toISOString().split("T")[0],
		YEAR: String(now.getFullYear()),
		MONTH: String(now.getMonth() + 1).padStart(2, "0"),
		DAY: String(now.getDate()).padStart(2, "0"),
	};
}

/**
 * Build the complete variable context for template rendering
 */
export function buildRenderContext(
	userVariables: Record<string, string>,
	dataResults: Record<string, unknown>,
	userId: string,
	organizationId?: string,
): RenderContext {
	return {
		variables: {
			...getReportDateVariables(),
			...userVariables,
		},
		dataResults,
		userId,
		organizationId,
	};
}

// =============================================================================
// Helpers
// =============================================================================

function substituteVariables(
	template: string,
	variables: Record<string, string>,
): string {
	let result = template;
	for (const [key, value] of Object.entries(variables)) {
		// Support both {{variable:name}} and {{variableName}} syntax
		result = result.replace(
			new RegExp(`\\{\\{variable:${key}\\}\\}`, "gi"),
			value,
		);
		result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "gi"), value);
	}
	return result;
}

function containsFabricPlugins(content: string): boolean {
	// Check for {{plugin:...}} syntax
	return /\{\{plugin:[^}]+\}\}/.test(content);
}

function formatDataForSection(
	data: unknown,
	config?: Record<string, unknown>,
): string {
	const format = (config?.format as string) || "json";

	switch (format) {
		case "table":
			return formatAsTable(data);
		case "list":
			return formatAsList(data);
		default:
			return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
	}
}

function formatAsTable(data: unknown): string {
	if (!Array.isArray(data) || data.length === 0) {
		return formatAsList(data);
	}

	const firstItem = data[0];
	if (typeof firstItem !== "object" || firstItem === null) {
		return formatAsList(data);
	}

	const headers = Object.keys(firstItem);
	const headerRow = `| ${headers.join(" | ")} |`;
	const separatorRow = `| ${headers.map(() => "---").join(" | ")} |`;
	const dataRows = data.map(
		(item: Record<string, unknown>) =>
			`| ${headers.map((h) => String(item[h] ?? "")).join(" | ")} |`,
	);

	return [headerRow, separatorRow, ...dataRows].join("\n");
}

function formatAsList(data: unknown): string {
	if (Array.isArray(data)) {
		return data
			.map((item, i) => `${i + 1}. ${JSON.stringify(item)}`)
			.join("\n");
	}
	if (typeof data === "object" && data !== null) {
		return Object.entries(data)
			.map(([key, value]) => `- **${key}**: ${JSON.stringify(value)}`)
			.join("\n");
	}
	return String(data);
}
