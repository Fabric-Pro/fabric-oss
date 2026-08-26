/**
 * Template Mapper
 *
 * Maps Fabric report template sections to Evidence page content.
 */

import {
	generateChart,
	generateCodeBlock,
	generateDataTable,
	generateDetails,
	generateDivider,
	generateLastRefreshed,
	generateMetadataLine,
	generateMetricsGrid,
	generatePageFooter,
	generatePageHeader,
	generateSectionHeader,
} from "../components";
import type {
	AiAnalysisResult,
	ChartConfig,
	DataSourceResult,
	DateRange,
	EvidencePage,
	FabricSectionConfig,
	FabricTemplateDefinition,
	MetricConfig,
	TableConfig,
} from "../types";
import { sanitizeSourceName } from "./data-source-mapper";

/**
 * Configuration for page generation
 */
export interface PageGeneratorConfig {
	template: {
		id: string;
		name: string;
		description?: string | null;
		templateType: string;
		definition: FabricTemplateDefinition;
	};
	dataResults: DataSourceResult[];
	aiResults: AiAnalysisResult[];
	parameters: Record<string, unknown>;
	dateRange?: DateRange;
}

/**
 * Generate Evidence pages from Fabric template
 */
export function generatePages(config: PageGeneratorConfig): EvidencePage[] {
	const pages: EvidencePage[] = [];

	// Generate main report page
	const mainPage = generateMainPage(config);
	pages.push(mainPage);

	// Generate detail pages for each data source (if configured)
	// This could be extended to create multi-page reports

	return pages;
}

/**
 * Generate the main report page
 */
function generateMainPage(config: PageGeneratorConfig): EvidencePage {
	const { template, dataResults, aiResults, parameters, dateRange } = config;
	const sections = template.definition.sections || [];

	const contentParts: string[] = [];

	// Page header
	contentParts.push(
		generatePageHeader({
			title: interpolateString(template.name, parameters),
			subtitle: template.description
				? interpolateString(template.description, parameters)
				: undefined,
		}),
	);

	// Metadata line
	const metadataItems: Array<{ label: string; value: string }> = [];

	if (dateRange) {
		metadataItems.push({
			label: "Period",
			value: `${dateRange.start} to ${dateRange.end}`,
		});
	}

	metadataItems.push({
		label: "Type",
		value: template.templateType.replace(/_/g, " "),
	});

	if (metadataItems.length > 0) {
		contentParts.push("");
		contentParts.push(generateMetadataLine(metadataItems));
	}

	contentParts.push("");
	contentParts.push(generateLastRefreshed());
	contentParts.push("");
	contentParts.push("---");
	contentParts.push("");

	// Generate content for each section
	for (const section of sections) {
		// Skip hidden sections
		if (section.evidenceConfig?.hidden) {
			continue;
		}

		const sectionContent = generateSectionContent(
			section,
			dataResults,
			aiResults,
			parameters,
		);

		if (sectionContent) {
			contentParts.push(sectionContent);
			contentParts.push("");
		}
	}

	// Page footer
	contentParts.push(
		generatePageFooter({
			generatedAt: new Date(),
			source: "Fabric Reports",
		}),
	);

	return {
		slug: "index",
		title: template.name,
		frontmatter: {
			title: template.name,
			description: template.description || undefined,
		},
		content: contentParts.join("\n"),
	};
}

/**
 * Generate content for a single section
 */
function generateSectionContent(
	section: FabricSectionConfig,
	dataResults: DataSourceResult[],
	aiResults: AiAnalysisResult[],
	parameters: Record<string, unknown>,
): string | null {
	// Check for Evidence component override
	if (section.evidenceConfig?.component) {
		return generateCustomComponent(section);
	}

	// Map section type to Evidence content
	switch (section.type) {
		case "text":
			return generateTextSection(section, parameters);

		case "ai-generated":
			return generateAiSection(section, aiResults);

		case "metrics":
			return generateMetricsSection(section, dataResults);

		case "table":
			return generateTableSection(section, dataResults);

		case "chart":
			return generateChartSection(section, dataResults);

		case "data":
			return generateDataSection(section, dataResults);

		case "raw":
			return generateRawSection(section, dataResults, aiResults);

		case "divider":
			return generateDivider(
				section.title !== "Divider" ? section.title : undefined,
			);

		default:
			return null;
	}
}

/**
 * Generate text section
 */
function generateTextSection(
	section: FabricSectionConfig,
	parameters: Record<string, unknown>,
): string {
	const config = section.config as { template?: string } | undefined;
	const template = config?.template || "";

	return interpolateString(template, parameters);
}

/**
 * Generate AI-generated section
 */
function generateAiSection(
	section: FabricSectionConfig,
	aiResults: AiAnalysisResult[],
): string | null {
	const config = section.config as
		| {
				outputVariable?: string;
				wrapperTemplate?: string;
		  }
		| undefined;

	const outputVariable = config?.outputVariable || section.id;
	const aiResult = aiResults.find((r) => r.outputVariable === outputVariable);

	if (!aiResult || !aiResult.content) {
		return null;
	}

	const wrapperTemplate =
		config?.wrapperTemplate || `## ${section.title}\n\n{{content}}`;

	return wrapperTemplate.replace("{{content}}", aiResult.content);
}

/**
 * Generate metrics section with BigValue components
 */
function generateMetricsSection(
	section: FabricSectionConfig,
	dataResults: DataSourceResult[],
): string {
	const config = section.config as
		| {
				dataSourceId?: string;
				metrics?: Array<{
					field: string;
					label: string;
					format?: string;
					comparison?: string;
				}>;
		  }
		| undefined;

	const parts: string[] = [];

	if (section.title) {
		parts.push(generateSectionHeader(section.title));
		parts.push("");
	}

	if (!config?.metrics || config.metrics.length === 0) {
		return parts.join("\n");
	}

	const dataSource = config.dataSourceId
		? dataResults.find((r) => r.sourceId === config.dataSourceId)
		: dataResults[0];

	const sourceName = dataSource
		? sanitizeSourceName(dataSource.sourceId)
		: "metrics";

	const metricConfigs: MetricConfig[] = config.metrics.map((m) => ({
		dataSource: sourceName,
		value: m.field,
		title: m.label,
		format: m.format,
		comparison: m.comparison,
	}));

	parts.push(
		generateMetricsGrid(metricConfigs, Math.min(metricConfigs.length, 4)),
	);

	return parts.join("\n");
}

/**
 * Generate table section with DataTable component
 */
function generateTableSection(
	section: FabricSectionConfig,
	dataResults: DataSourceResult[],
): string {
	const config = section.config as
		| {
				dataSourceId?: string;
				columns?: Array<{
					field: string;
					label?: string;
					format?: string;
				}>;
				search?: boolean;
				pagination?: boolean;
				rowsPerPage?: number;
		  }
		| undefined;

	const parts: string[] = [];

	if (section.title) {
		parts.push(generateSectionHeader(section.title));
		parts.push("");
	}

	const dataSource = config?.dataSourceId
		? dataResults.find((r) => r.sourceId === config.dataSourceId)
		: dataResults[0];

	if (!dataSource) {
		parts.push("*No data available*");
		return parts.join("\n");
	}

	const sourceName = sanitizeSourceName(dataSource.sourceId);

	const tableConfig: TableConfig = {
		dataSource: sourceName,
		columns: config?.columns?.map((c) => ({
			field: c.field,
			label: c.label,
			format: c.format,
		})),
		search: config?.search,
		pagination: config?.pagination,
		rowsPerPage: config?.rowsPerPage,
	};

	parts.push(generateDataTable(tableConfig));

	return parts.join("\n");
}

/**
 * Generate chart section
 */
function generateChartSection(
	section: FabricSectionConfig,
	dataResults: DataSourceResult[],
): string {
	const config = section.config as
		| {
				dataSourceId?: string;
				chartType?: "line" | "bar" | "area" | "scatter" | "pie";
				xAxis?: string;
				yAxis?: string | string[];
				series?: string;
				title?: string;
		  }
		| undefined;

	const parts: string[] = [];

	if (section.title) {
		parts.push(generateSectionHeader(section.title));
		parts.push("");
	}

	const dataSource = config?.dataSourceId
		? dataResults.find((r) => r.sourceId === config.dataSourceId)
		: dataResults[0];

	if (!dataSource || !config?.xAxis || !config?.yAxis) {
		parts.push("*Chart configuration incomplete or no data available*");
		return parts.join("\n");
	}

	const sourceName = sanitizeSourceName(dataSource.sourceId);

	const chartConfig: ChartConfig = {
		dataSource: sourceName,
		title: config.title || section.title,
		xAxis: config.xAxis,
		yAxis: config.yAxis,
		series: config.series,
		chartType: config.chartType || "line",
	};

	parts.push(generateChart(chartConfig));

	return parts.join("\n");
}

/**
 * Generate data section (raw data display)
 */
function generateDataSection(
	section: FabricSectionConfig,
	dataResults: DataSourceResult[],
): string {
	const config = section.config as
		| {
				dataSourceId?: string;
				format?: "table" | "json" | "summary";
		  }
		| undefined;

	const parts: string[] = [];

	if (section.title) {
		parts.push(generateSectionHeader(section.title));
		parts.push("");
	}

	const dataSource = config?.dataSourceId
		? dataResults.find((r) => r.sourceId === config.dataSourceId)
		: dataResults[0];

	if (!dataSource) {
		parts.push("*No data available*");
		return parts.join("\n");
	}

	const format = config?.format || "table";

	if (format === "json") {
		const _sourceName = sanitizeSourceName(dataSource.sourceId);
		parts.push(
			generateDetails({
				summary: "View Raw Data",
				content: generateCodeBlock(
					JSON.stringify(dataSource.data, null, 2),
					"json",
				),
			}),
		);
	} else if (format === "summary") {
		const data = dataSource.data as Record<string, unknown>[];
		parts.push(`**Records:** ${data.length}`);

		if (data.length > 0) {
			const fields = Object.keys(data[0]);
			parts.push(`**Fields:** ${fields.join(", ")}`);
		}
	} else {
		// Default: table
		const sourceName = sanitizeSourceName(dataSource.sourceId);
		parts.push(
			generateDataTable({
				dataSource: sourceName,
				search: true,
				rowsPerPage: 10,
			}),
		);
	}

	return parts.join("\n");
}

/**
 * Generate raw section (code block or collapsible)
 */
function generateRawSection(
	section: FabricSectionConfig,
	dataResults: DataSourceResult[],
	aiResults: AiAnalysisResult[],
): string {
	const config = section.config as
		| {
				content?: string;
				outputVariable?: string;
				dataSourceId?: string;
				language?: string;
				collapsible?: boolean;
		  }
		| undefined;

	const parts: string[] = [];

	if (section.title) {
		parts.push(generateSectionHeader(section.title));
		parts.push("");
	}

	let content = "";

	if (config?.content) {
		content = config.content;
	} else if (config?.outputVariable) {
		const aiResult = aiResults.find(
			(r) => r.outputVariable === config.outputVariable,
		);
		content = aiResult?.content || "";
	} else if (config?.dataSourceId) {
		const dataSource = dataResults.find(
			(r) => r.sourceId === config.dataSourceId,
		);
		content = JSON.stringify(dataSource?.data, null, 2);
	}

	if (!content) {
		return parts.join("\n");
	}

	if (config?.collapsible) {
		parts.push(
			generateDetails({
				summary: section.title || "Details",
				content: generateCodeBlock(content, config.language),
			}),
		);
	} else {
		parts.push(generateCodeBlock(content, config?.language));
	}

	return parts.join("\n");
}

/**
 * Generate custom Evidence component from override config
 */
function generateCustomComponent(section: FabricSectionConfig): string {
	// biome-ignore lint/style/noNonNullAssertion: evidenceConfig is required for custom components
	const { component, props } = section.evidenceConfig!;
	const parts: string[] = [];

	if (section.title) {
		parts.push(generateSectionHeader(section.title));
		parts.push("");
	}

	// Generate component with props
	const propsString = props
		? Object.entries(props)
				.map(([key, value]) => {
					if (typeof value === "string") {
						return `${key}="${value}"`;
					}
					return `${key}={${JSON.stringify(value)}}`;
				})
				.join("\n\t")
		: "";

	parts.push(`<${component}
	${propsString}
/>`);

	return parts.join("\n");
}

/**
 * Interpolate parameter values into a string
 */
function interpolateString(
	template: string,
	parameters: Record<string, unknown>,
): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
		const value = parameters[key];
		if (value === undefined || value === null) {
			return match;
		}
		return String(value);
	});
}

/**
 * Generate page frontmatter as YAML
 */
export function generateFrontmatter(
	frontmatter: Record<string, unknown>,
): string {
	const lines = ["---"];

	for (const [key, value] of Object.entries(frontmatter)) {
		if (value === undefined) {
			continue;
		}

		if (typeof value === "string") {
			lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
		} else if (Array.isArray(value)) {
			lines.push(`${key}:`);
			for (const item of value) {
				lines.push(`  - ${JSON.stringify(item)}`);
			}
		} else if (typeof value === "object" && value !== null) {
			lines.push(`${key}: ${JSON.stringify(value)}`);
		} else {
			lines.push(`${key}: ${value}`);
		}
	}

	lines.push("---");
	return lines.join("\n");
}

/**
 * Generate full page content with frontmatter
 */
export function generatePageContent(page: EvidencePage): string {
	const frontmatter = generateFrontmatter(page.frontmatter);
	return `${frontmatter}\n\n${page.content}`;
}
