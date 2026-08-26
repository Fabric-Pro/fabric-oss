/**
 * Evidence.dev Project Generator Types
 *
 * Types for generating Evidence projects from Fabric report templates.
 */

import { z } from "zod";

// =============================================================================
// Evidence Project Types
// =============================================================================

/**
 * Complete Evidence project structure
 */
export interface EvidenceProject {
	name: string;
	config: EvidenceConfig;
	sources: EvidenceDataSource[];
	pages: EvidencePage[];
	theme?: EvidenceTheme;
}

/**
 * Evidence configuration (evidence.config.yaml)
 */
export interface EvidenceConfig {
	title: string;
	description?: string;
	appearance?: {
		title?: string;
		logo?: string;
		favicon?: string;
	};
	layout?: {
		sidebar?: boolean;
		header?: boolean;
	};
}

/**
 * Evidence data source (JSON/CSV file in sources directory)
 */
export interface EvidenceDataSource {
	name: string;
	type: "json" | "csv";
	data: unknown[];
	schema?: DataSourceSchema;
}

/**
 * Schema for data source columns
 */
export interface DataSourceSchema {
	columns: Array<{
		name: string;
		type: "string" | "number" | "boolean" | "date";
		description?: string;
	}>;
}

/**
 * Evidence page (markdown file)
 */
export interface EvidencePage {
	slug: string;
	title: string;
	frontmatter: Record<string, unknown>;
	content: string;
}

/**
 * Evidence theme configuration
 */
export interface EvidenceTheme {
	colors?: {
		primary?: string;
		secondary?: string;
		accent?: string;
		background?: string;
		surface?: string;
		text?: string;
	};
	fonts?: {
		heading?: string;
		body?: string;
		mono?: string;
	};
	borderRadius?: string;
}

// =============================================================================
// Fabric Input Types (from report templates/executions)
// =============================================================================

/**
 * Fabric report template definition structure
 */
export interface FabricTemplateDefinition {
	dataSources?: FabricDataSourceConfig[];
	aiAgents?: FabricAiAgentConfig[];
	sections?: FabricSectionConfig[];
}

/**
 * Data source configuration in template
 */
export interface FabricDataSourceConfig {
	id: string;
	type: "fabric" | "mcp" | "api" | "workspace" | "user-input";
	config?: Record<string, unknown>;
}

/**
 * AI agent configuration in template
 */
export interface FabricAiAgentConfig {
	agentId: string;
	task: string;
	outputVariable: string;
}

/**
 * Section configuration in template
 */
export interface FabricSectionConfig {
	id: string;
	title: string;
	type:
		| "text"
		| "table"
		| "ai-generated"
		| "data"
		| "raw"
		| "metrics"
		| "chart"
		| "divider";
	config?: Record<string, unknown>;
	evidenceConfig?: EvidenceSectionOverride;
}

/**
 * Evidence-specific section overrides
 */
export interface EvidenceSectionOverride {
	component?: string;
	props?: Record<string, unknown>;
	hidden?: boolean;
}

/**
 * Result from a data source fetch
 */
export interface DataSourceResult {
	sourceId: string;
	sourceType: string;
	data: unknown[];
	metadata?: Record<string, unknown>;
	error?: string;
}

/**
 * Result from AI analysis
 */
export interface AiAnalysisResult {
	agentId: string;
	outputVariable: string;
	content: string;
	metadata?: Record<string, unknown>;
	error?: string;
}

/**
 * Date range for report execution
 */
export interface DateRange {
	start: string;
	end: string;
	period?: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
}

// =============================================================================
// Generator Input/Output Types
// =============================================================================

/**
 * Input to the Evidence project generator
 */
export interface GeneratorInput {
	/** Report template with definition */
	template: {
		id: string;
		name: string;
		description?: string | null;
		templateType: string;
		definition: FabricTemplateDefinition;
		outputFormat: string;
		fabricConfig?: FabricEnrichmentConfig | null;
		evidenceProjectId?: string | null;
		evidenceReportSlug?: string | null;
	};

	/** Results from data source fetches */
	dataResults: DataSourceResult[];

	/** Results from AI analysis */
	aiResults: AiAnalysisResult[];

	/** Merged parameters (template defaults + runtime overrides) */
	parameters: Record<string, unknown>;

	/** Date range for the report */
	dateRange?: DateRange;

	/** Evidence-specific configuration overrides */
	evidenceOverrides?: {
		theme?: EvidenceTheme;
		layout?: EvidenceConfig["layout"];
	};
}

/**
 * Fabric AI enrichment configuration
 */
export interface FabricEnrichmentConfig {
	strategy?: string;
	context?: string;
	pattern?: string;
	variables?: Record<string, string>;
	enableAutoDetection?: boolean;
}

/**
 * Output from the Evidence project generator
 */
export interface GeneratorOutput {
	/** Path to the generated Evidence project directory */
	projectDir: string;

	/** List of generated files */
	files: GeneratedFile[];

	/** Any warnings during generation */
	warnings?: string[];
}

/**
 * Generated file info
 */
export interface GeneratedFile {
	path: string;
	type: "config" | "source" | "page" | "theme" | "static";
	size: number;
}

// =============================================================================
// Component Mapping Types
// =============================================================================

/**
 * Chart configuration for Evidence components
 */
export interface ChartConfig {
	dataSource: string;
	title?: string;
	xAxis: string;
	yAxis: string | string[];
	series?: string;
	chartType?: "line" | "bar" | "area" | "scatter" | "pie";
	stacked?: boolean;
	showLegend?: boolean;
}

/**
 * Table configuration for Evidence DataTable
 */
export interface TableConfig {
	dataSource: string;
	title?: string;
	columns?: Array<{
		field: string;
		label?: string;
		format?: string;
		align?: "left" | "center" | "right";
	}>;
	search?: boolean;
	pagination?: boolean;
	rowsPerPage?: number;
}

/**
 * Metric/BigValue configuration
 */
export interface MetricConfig {
	dataSource: string;
	value: string;
	title: string;
	format?: string;
	comparison?: string;
	comparisonTitle?: string;
}

// =============================================================================
// Zod Schemas for Validation
// =============================================================================

export const EvidenceThemeSchema = z.object({
	colors: z
		.object({
			primary: z.string().optional(),
			secondary: z.string().optional(),
			accent: z.string().optional(),
			background: z.string().optional(),
			surface: z.string().optional(),
			text: z.string().optional(),
		})
		.optional(),
	fonts: z
		.object({
			heading: z.string().optional(),
			body: z.string().optional(),
			mono: z.string().optional(),
		})
		.optional(),
	borderRadius: z.string().optional(),
});

export const ChartConfigSchema = z.object({
	dataSource: z.string(),
	title: z.string().optional(),
	xAxis: z.string(),
	yAxis: z.union([z.string(), z.array(z.string())]),
	series: z.string().optional(),
	chartType: z.enum(["line", "bar", "area", "scatter", "pie"]).optional(),
	stacked: z.boolean().optional(),
	showLegend: z.boolean().optional(),
});

export const TableConfigSchema = z.object({
	dataSource: z.string(),
	title: z.string().optional(),
	columns: z
		.array(
			z.object({
				field: z.string(),
				label: z.string().optional(),
				format: z.string().optional(),
				align: z.enum(["left", "center", "right"]).optional(),
			}),
		)
		.optional(),
	search: z.boolean().optional(),
	pagination: z.boolean().optional(),
	rowsPerPage: z.number().optional(),
});

export const MetricConfigSchema = z.object({
	dataSource: z.string(),
	value: z.string(),
	title: z.string(),
	format: z.string().optional(),
	comparison: z.string().optional(),
	comparisonTitle: z.string().optional(),
});
