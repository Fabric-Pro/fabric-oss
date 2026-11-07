import { z } from "zod";
/** Public report results never forward provider messages, configuration IDs, remote server names or URLs. */
export const reportDiagnosticProviderSchema = z.enum([
	"azure_devops",
	"github",
	"gitlab",
	"linear",
	"fizzy",
	"microsoft_graph",
	"slack",
	"teams",
	"notion",
	"confluence",
	"google_drive",
	"sharepoint",
	"fabric",
	"other",
]);
export const reportDiagnosticStatusSchema = z.enum([
	"connected",
	"auth_failed",
	"unreachable",
	"zero_tools",
	"no_read_only_tools",
	"error",
	"unavailable",
]);
export const reportDiagnosticReasonSchema = z.enum([
	"AVAILABLE",
	"AUTH_REQUIRED",
	"NETWORK_UNAVAILABLE",
	"NO_TOOLS",
	"NO_SAFE_TOOLS",
	"CONNECTION_FAILED",
	"INVALID_DIAGNOSTIC",
	"DIAGNOSTICS_TRUNCATED",
]);
export const reportConnectionDiagnosticSchema = z
	.strictObject({
		providerType: reportDiagnosticProviderSchema,
		displayLabel: z
			.string()
			.min(1)
			.max(100)
			.refine(
				(value) => safeReportDiagnosticLabel(value) !== null,
				"Unsafe source label",
			),
		status: reportDiagnosticStatusSchema,
		reasonCode: reportDiagnosticReasonSchema,
		toolCount: z.number().int().min(0).max(10000).nullable(),
		readOnlyToolCount: z.number().int().min(0).max(10000).nullable(),
	})
	.superRefine((value, context) => {
		if (
			(value.toolCount === null) !== (value.readOnlyToolCount === null) ||
			(value.toolCount !== null &&
				value.readOnlyToolCount !== null &&
				value.readOnlyToolCount > value.toolCount)
		) {
			context.addIssue({
				code: "custom",
				message: "Invalid diagnostic counts",
			});
		}
	});
export const reportConnectionDiagnosticsSchema = z
	.array(reportConnectionDiagnosticSchema)
	.max(20)
	.nullable();
export type ReportConnectionDiagnostic = z.infer<
	typeof reportConnectionDiagnosticSchema
>;
export interface ReportDiagnosticSource {
	displayLabel: string;
	providerType: ReportConnectionDiagnostic["providerType"];
}
/** Plain report-facing labels only; reject hosts, URLs, credential-like strings and opaque config identifiers. */
export function safeReportDiagnosticLabel(
	value: unknown,
	configIds: readonly string[] = [],
): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const label = value.trim().replace(/\s+/g, " ");
	if (
		!label ||
		label.length > 90 ||
		configIds.includes(label) ||
		!/[\p{L}]/u.test(label) ||
		!/^[\p{L}\p{N} _()'&–—-]+$/u.test(label) ||
		/bearer|api[ _-]?key|password|secret|token|localhost|[a-f0-9]{24,}|\b(?:sk-|gh[pousr]_|glpat-|xox[baprs]-|eyJ[A-Za-z0-9_-]{8})/i.test(
			label,
		) ||
		/^[a-z0-9]{20,}$/i.test(label) ||
		/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(label)
	) {
		return null;
	}
	return label;
}
const reasons = {
	connected: "AVAILABLE",
	auth_failed: "AUTH_REQUIRED",
	unreachable: "NETWORK_UNAVAILABLE",
	zero_tools: "NO_TOOLS",
	no_read_only_tools: "NO_SAFE_TOOLS",
	error: "CONNECTION_FAILED",
} as const;
const count = z.number().int().min(0).max(10000);
const unavailable = (
	reasonCode: "INVALID_DIAGNOSTIC" | "DIAGNOSTICS_TRUNCATED",
	providerType: ReportConnectionDiagnostic["providerType"] = "other",
): ReportConnectionDiagnostic => ({
	providerType,
	displayLabel: "Source details",
	status: "unavailable",
	reasonCode,
	toolCount: null,
	readOnlyToolCount: null,
});
/** Project only bounded structural facts. Unknown/malformed metadata remains explicitly unavailable. */
export function projectReportDiagnostics(
	value: unknown,
	sources: ReadonlyMap<string, ReportDiagnosticSource> = new Map(),
): ReportConnectionDiagnostic[] | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (!Array.isArray(value)) {
		return [unavailable("INVALID_DIAGNOSTIC")];
	}
	const result = value
		.slice(0, value.length > 20 ? 19 : 20)
		.map((raw, index): ReportConnectionDiagnostic => {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
				return unavailable("INVALID_DIAGNOSTIC");
			}
			const source = raw as Record<string, unknown>;
			const provider = reportDiagnosticProviderSchema.safeParse(
				source.provider,
			);
			const approved =
				typeof source.configId === "string"
					? sources.get(source.configId)
					: undefined;
			const providerType =
				approved?.providerType ??
				(provider.success ? provider.data : "other");
			const displayLabel =
				safeReportDiagnosticLabel(approved?.displayLabel) ??
				`Source ${index + 1}`;
			const outcome = z
				.enum([
					"connected",
					"auth_failed",
					"unreachable",
					"zero_tools",
					"no_read_only_tools",
					"error",
				])
				.safeParse(source.outcome);
			const total = count.safeParse(source.toolCount);
			const readOnly = count.safeParse(source.readOnlyToolCount);
			if (
				!outcome.success ||
				!total.success ||
				!readOnly.success ||
				readOnly.data > total.data
			) {
				return {
					...unavailable("INVALID_DIAGNOSTIC", providerType),
					displayLabel,
				};
			}
			return {
				providerType,
				displayLabel,
				status: outcome.data,
				reasonCode: reasons[outcome.data],
				toolCount: total.data,
				readOnlyToolCount: readOnly.data,
			};
		});
	if (value.length > 20) {
		result.push(unavailable("DIAGNOSTICS_TRUNCATED"));
	}
	return result;
}
