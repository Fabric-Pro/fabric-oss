import { TZDate } from "@date-fns/tz";
import {
	artifactBrandSelectionSchema,
	artifactBrandSnapshotSchema,
} from "@repo/utils/artifact-brand-snapshot";
import { addDays, addMonths, addYears, startOfDay } from "date-fns";
import { z } from "zod";

/** Reserved for a server-admitted snapshot; never accepted as a user parameter. */
export const REPORT_EXECUTION_SNAPSHOT_KEY = "__fabricReportExecution";
export const REPORT_RECOVERY_KEY = "__fabricReportRecovery";
const timeZone = z
	.string()
	.min(1)
	.max(100)
	.refine((value) => {
		try {
			new Intl.DateTimeFormat("en", { timeZone: value });
			return true;
		} catch {
			return false;
		}
	}, "Invalid IANA timezone");

/** Evidence periods do not change the recurrence/anchor of the existing scheduler. */
export const reportEvidenceConfigSchema = z.strictObject({
	version: z.literal(1),
	period: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]),
	timezone: timeZone.default("UTC"),
	weekStartsOn: z.number().int().min(0).max(6).default(1),
	calendar: z.enum(["calendar", "fiscal"]).default("calendar"),
	fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
	comparison: z
		.enum(["none", "previous_period", "previous_year"])
		.default("none"),
	partialData: z
		.enum(["allow_with_notice", "require_complete"])
		.default("allow_with_notice"),
	publication: z.enum(["draft", "review"]).default("draft"),
	// Organization ownership remains unchanged. This narrows both evidence and readers.
	projectId: z.string().min(1).max(128).optional(),
	branding: artifactBrandSelectionSchema.optional(),
	/** Generate an offline PDF from this occurrence's exact report document. */
	generatePdf: z.boolean().optional(),
});
export type ReportEvidenceConfig = z.infer<typeof reportEvidenceConfigSchema>;
const interval = z.strictObject({
	start: z.string().datetime(),
	end: z.string().datetime(),
});
export const reportEvidenceWindowSchema = interval.extend({
	cutoff: z.string().datetime(),
	timezone: timeZone,
	comparison: interval.optional(),
});
export type ReportEvidenceWindow = z.infer<typeof reportEvidenceWindowSchema>;

/** Last closed local period, [start,end), observed at a pinned occurrence cutoff. */
export function computeReportEvidenceWindow(
	config: ReportEvidenceConfig,
	cutoff: Date,
): ReportEvidenceWindow {
	if (!Number.isFinite(cutoff.getTime())) {
		throw new Error("Invalid report cutoff");
	}
	const local = new TZDate(cutoff, config.timezone);
	let end = startOfDay(local);
	let months = 0;
	if (config.period === "weekly") {
		end = addDays(end, -((end.getDay() - config.weekStartsOn + 7) % 7));
	}
	if (["monthly", "quarterly", "yearly"].includes(config.period)) {
		const offset =
			config.calendar === "fiscal" ? config.fiscalYearStartMonth - 1 : 0;
		months =
			config.period === "monthly"
				? 1
				: config.period === "quarterly"
					? 3
					: 12;
		const monthIndex = end.getFullYear() * 12 + end.getMonth();
		const boundary =
			monthIndex - ((((monthIndex - offset) % months) + months) % months);
		end = new TZDate(
			Math.floor(boundary / 12),
			boundary % 12,
			1,
			config.timezone,
		);
	}
	const previous = (date: TZDate) =>
		months
			? addMonths(date, -months)
			: addDays(date, config.period === "weekly" ? -7 : -1);
	const start = previous(end);
	const window: ReportEvidenceWindow = {
		start: new Date(start.getTime()).toISOString(),
		end: new Date(end.getTime()).toISOString(),
		cutoff: cutoff.toISOString(),
		timezone: config.timezone,
	};
	if (config.comparison !== "none") {
		const baselineEnd =
			config.comparison === "previous_year" ? addYears(end, -1) : start;
		const baselineStart =
			config.comparison === "previous_year"
				? addYears(start, -1)
				: previous(start);
		window.comparison = {
			start: new Date(baselineStart.getTime()).toISOString(),
			end: new Date(baselineEnd.getTime()).toISOString(),
		};
	}
	return window;
}

export const reportExecutionSnapshotSchema = z.strictObject({
	version: z.literal(1),
	organizationId: z.string().min(1),
	userId: z.string().min(1),
	instanceId: z.string().min(1),
	occurrenceAt: z.string().datetime(),
	origin: z.enum(["manual", "scheduled"]),
	skills: z
		.array(
			z.strictObject({
				id: z.string(),
				version: z.number().int(),
				updatedAt: z.string().datetime(),
				name: z.string().max(255),
				content: z.string(),
			}),
		)
		.max(32)
		.default([]),
	hashes: z
		.strictObject({
			config: z.string().regex(/^[a-f0-9]{64}$/),
			window: z.string().regex(/^[a-f0-9]{64}$/),
			target: z.string().regex(/^[a-f0-9]{64}$/),
		})
		.optional(),
	branding: artifactBrandSnapshotSchema.optional(),
	config: reportEvidenceConfigSchema.optional(),
	window: reportEvidenceWindowSchema.optional(),
	// Pinned non-secret configuration, bounded before persistence. Credentials are resolved at use.
	instance: z.record(z.string(), z.unknown()),
});
export type ReportExecutionSnapshot = z.infer<
	typeof reportExecutionSnapshotSchema
>;

export function readReportEvidenceConfig(
	fabricConfig: unknown,
): ReportEvidenceConfig | undefined {
	if (
		!fabricConfig ||
		typeof fabricConfig !== "object" ||
		!("reporting" in fabricConfig)
	) {
		return undefined;
	}
	return reportEvidenceConfigSchema.parse(
		(fabricConfig as Record<string, unknown>).reporting,
	);
}

export function assertPublicReportParameters(parameters: unknown): void {
	if (
		parameters &&
		typeof parameters === "object" &&
		(REPORT_EXECUTION_SNAPSHOT_KEY in parameters ||
			REPORT_RECOVERY_KEY in parameters)
	) {
		throw new Error("Reserved report execution parameter");
	}
	if (
		parameters &&
		new TextEncoder().encode(JSON.stringify(parameters)).length > 32_000
	) {
		throw new Error("Report parameters exceed the size limit");
	}
}

export function buildReportExecutionSnapshot(input: {
	instance: Record<string, unknown>;
	organizationId: string;
	userId: string;
	occurrenceAt: Date;
	origin: "manual" | "scheduled";
}): ReportExecutionSnapshot {
	const config = readReportEvidenceConfig(input.instance.fabricConfig);
	if (config?.branding) {
		assertReportBrandingOutputFormat(
			(input.instance.template as { outputFormat?: unknown } | undefined)
				?.outputFormat,
		);
	}
	assertPublicReportParameters(input.instance.parameterDefaults);
	const snapshot = reportExecutionSnapshotSchema.parse({
		version: 1,
		organizationId: input.organizationId,
		userId: input.userId,
		instanceId: input.instance.id,
		occurrenceAt: input.occurrenceAt.toISOString(),
		origin: input.origin,
		config,
		window: config
			? computeReportEvidenceWindow(config, input.occurrenceAt)
			: undefined,
		instance: {
			id: input.instance.id,
			name: input.instance.name,
			templateId: input.instance.templateId,
			version: input.instance.version,
			connections: input.instance.connections,
			parameterDefaults: input.instance.parameterDefaults,
			fabricConfig: input.instance.fabricConfig,
			template: input.instance.template,
		},
	});
	// Only configuration is pinned. Refuse oversized snapshots rather than overflow Temporal/DB payloads.
	if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 128_000) {
		throw new Error(
			"Report execution configuration exceeds the snapshot limit",
		);
	}
	return snapshot;
}

/** Caller-facing schema rejects reserved snapshots and oversized prompt parameters with 400 validation. */
export const publicReportParametersSchema = z
	.record(z.string(), z.unknown())
	.superRefine((parameters, context) => {
		try {
			assertPublicReportParameters(parameters);
		} catch (error) {
			context.addIssue({
				code: "custom",
				message:
					error instanceof Error
						? error.message
						: "Invalid report parameters",
			});
		}
	});

export const PROJECT_REPORT_SETUP_REQUIRED =
	"Project report setup required: use Project knowledge as the only source and choose a project. External MCP, integrations and private sources do not have a server-verified project audience binding. This draft cannot run or be scheduled.";
export const projectKnowledgeSelectionSchema = z.strictObject({
	limit: z.number().int().min(1).max(10).default(10),
	documentIds: z.array(z.string().min(1).max(128)).max(50).optional(),
	contextIds: z.array(z.string().min(1).max(128)).max(50).optional(),
});
export function isProjectKnowledgeSource(source: unknown): boolean {
	if (!source || typeof source !== "object") {
		return false;
	}
	const row = source as Record<string, unknown>;
	return (
		row.type === "fabric" &&
		row.provider === "fabric_project" &&
		row.operation === "project_knowledge" &&
		projectKnowledgeSelectionSchema.safeParse(row.config ?? {}).success
	);
}
export function hasProjectKnowledgeSource(definition: unknown): boolean {
	return (
		!!definition &&
		typeof definition === "object" &&
		Array.isArray((definition as { dataSources?: unknown }).dataSources) &&
		(definition as { dataSources: unknown[] }).dataSources.some(
			isProjectKnowledgeSource,
		)
	);
}
export function getProjectReportSetupReason(
	fabricConfig: unknown,
	definition?: unknown,
	connections?: unknown,
): string | undefined {
	if (!readReportEvidenceConfig(fabricConfig)?.projectId) {
		return undefined;
	}
	const sources = (definition as { dataSources?: unknown[] } | null)
		?.dataSources;
	const bindings = (connections ?? {}) as Record<string, unknown>;
	const hasExternalBinding =
		[
			"mcpConfigs",
			"integrations",
			"workflows",
			"agents",
			"workspaces",
		].some(
			(key) =>
				Array.isArray(bindings[key]) &&
				(bindings[key] as unknown[]).length > 0,
		) ||
		["mcpBindings", "integrationBindings", "workspaceBindings"].some(
			(key) =>
				bindings[key] &&
				typeof bindings[key] === "object" &&
				Object.keys(bindings[key] as object).length > 0,
		);
	return !sources?.length ||
		sources.length > 1 ||
		!sources.every(isProjectKnowledgeSource) ||
		hasExternalBinding
		? PROJECT_REPORT_SETUP_REQUIRED
		: undefined;
}
export function assertProjectReportSourcesReady(
	fabricConfig: unknown,
	parameters?: unknown,
	definition?: unknown,
	connections?: unknown,
): void {
	if (getProjectReportSetupReason(fabricConfig, definition, connections)) {
		throw new Error(PROJECT_REPORT_SETUP_REQUIRED);
	}
	if (
		parameters &&
		typeof parameters === "object" &&
		REPORT_EXECUTION_SNAPSHOT_KEY in parameters
	) {
		const snapshot = reportExecutionSnapshotSchema.parse(
			(parameters as Record<string, unknown>)[
				REPORT_EXECUTION_SNAPSHOT_KEY
			],
		);
		if (
			snapshot.config?.projectId &&
			getProjectReportSetupReason(
				{ reporting: snapshot.config },
				(
					snapshot.instance.template as
						| { definition?: unknown }
						| undefined
				)?.definition,
				snapshot.instance.connections,
			)
		) {
			throw new Error(PROJECT_REPORT_SETUP_REQUIRED);
		}
	}
}

/** Document formats share one report-derived Frame; native PDF uses its exact revision. */
export function assertReportBrandingOutputFormat(outputFormat: unknown): void {
	if (
		!["MARKDOWN", "HTML", "PDF", "MULTI_FORMAT"].includes(
			String(outputFormat),
		)
	) {
		throw new Error(
			"Choose a document report format (Markdown, HTML, PDF or multi-format) to apply branding.",
		);
	}
}
