import type { FabricHttpClient } from "../client.js";
import type { FabricReportExecution, FabricReportTemplate } from "../types.js";
import type { ArtifactBrandChoices } from "./frames.js";

export interface ListReportTemplatesOptions {
	org?: string;
	personal?: boolean;
	limit?: number;
	offset?: number;
	search?: string;
	category?: string;
}

/** Legacy ReportExecution listing. Use listInstanceExecutions for native report runs. */
export interface ListReportExecutionsOptions {
	org?: string;
	personal?: boolean;
	limit?: number;
	offset?: number;
	templateId?: string;
	status?: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
}
export interface ListReportInstanceExecutionsOptions {
	org?: string;
	limit?: number;
	cursor?: string;
	status?: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
}

/** Bounded connection facts and approved report-source labels; never forwards remote names, errors, IDs or URLs. */
export interface ReportConnectionDiagnostic {
	displayLabel: string;
	providerType:
		| "azure_devops"
		| "github"
		| "gitlab"
		| "linear"
		| "fizzy"
		| "microsoft_graph"
		| "slack"
		| "teams"
		| "notion"
		| "confluence"
		| "google_drive"
		| "sharepoint"
		| "fabric"
		| "other";
	status:
		| "connected"
		| "auth_failed"
		| "unreachable"
		| "zero_tools"
		| "no_read_only_tools"
		| "error"
		| "unavailable";
	reasonCode:
		| "AVAILABLE"
		| "AUTH_REQUIRED"
		| "NETWORK_UNAVAILABLE"
		| "NO_TOOLS"
		| "NO_SAFE_TOOLS"
		| "CONNECTION_FAILED"
		| "INVALID_DIAGNOSTIC"
		| "DIAGNOSTICS_TRUNCATED";
	toolCount: number | null;
	readOnlyToolCount: number | null;
}
export interface ReportHistoryExecution {
	mcpDiagnostics: ReportConnectionDiagnostic[] | null;
	id: string;
	instanceId: string;
	userId: string;
	status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
	startedAt: string | null;
	completedAt: string | null;
	duration: number | null;
	error: string | null;
	createdAt: string;
	artifacts: ReportArtifactReference[];
}
export interface NativeReportPage<T> {
	hasMore: boolean;
	nextCursor: string | null;
	executions?: T[];
	artifacts?: T[];
}

export interface ReportInstanceBrandingSelection {
	source: "COMPANY" | "CLIENT";
	expectedBrandVersion: number;
}
export interface ReportInstanceBrandingUpdate {
	expectedInstanceVersion: number;
	expectedUpdatedAt: string;
	branding: ReportInstanceBrandingSelection | null;
}
export interface ReportInstanceBrandingChoices extends ArtifactBrandChoices {
	instanceId: string;
	instanceVersion: number;
	updatedAt: string;
	projectId: string | null;
	current: ReportInstanceBrandingSelection | null;
	canApply: boolean;
}
export interface ReportInstanceBrandingResult {
	instanceId: string;
	instanceVersion: number;
	updatedAt: string;
	projectId: string | null;
	branding: ReportInstanceBrandingSelection | null;
}
export interface ReportSettings {
	templateId: string;
	name: string;
	description?: string;
	connections: {
		mcpConfigs?: string[];
		workflows?: string[];
		agents?: string[];
		workspaces?: string[];
		integrations?: string[];
		[key: string]: unknown;
	};
	reporting?: {
		version: 1;
		period: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
		timezone?: string;
		projectId?: string;
		generatePdf?: boolean;
		branding?: ReportInstanceBrandingSelection;
		[key: string]: unknown;
	};
	schedule?: Record<string, unknown>;
}
export interface ReportConfigurationUpdate {
	expectedVersion: number;
	expectedUpdatedAt: string;
	name?: string;
	description?: string;
	connections?: ReportSettings["connections"];
	fabricConfig?: Record<string, unknown>;
	scheduleUpdate?:
		| { mode: "inherit" | "off" }
		| { mode: "custom"; schedule: Record<string, unknown> };
	isActive?: boolean;
	status?: "PENDING" | "ACTIVE" | "ARCHIVED" | "DRAFT";
}
export interface ReportArtifactReference {
	id: string;
	name: string;
	artifactType: string;
	mimeType: string;
	size: number | null;
	createdAt: string;
	linkedFrameId: string | null;
	artifactHash: string | null;
}
export interface ReportExecutionStatus {
	mcpDiagnostics: ReportConnectionDiagnostic[] | null;
	executionId: string;
	instanceId: string;
	status: string;
	startedAt: string | null;
	completedAt: string | null;
	duration: number | null;
	error: string | null;
	artifacts: ReportArtifactReference[];
}
export type ReportArtifactDownload = {
	mimeType: string;
	filename: string;
	artifactHash: string | null;
} & (
	| { type: "inline"; content: string }
	| { type: "url"; url: string; expiresIn: number }
);
export interface ReportDistributionInput {
	requestId: string;
	expectedArtifactHash: string;
	recipientUserIds: string[];
	message?: string;
}
export interface ReportDistributionReceipt {
	deliveryId: string;
	channel: "INBOX";
	recipientCount: number;
	distributedAt: string;
	replayed: boolean;
}
export interface ConfiguredReport {
	id: string;
	name: string;
	version: number;
	updatedAt: string;
	fabricConfig: unknown;
	schedule: unknown;
	executions: unknown[];
	[key: string]: unknown;
}
const orgQuery = (org?: string) =>
	org ? `?${new URLSearchParams({ org })}` : "";
export class ReportsResource {
	constructor(private readonly http: FabricHttpClient) {}

	listInstances(
		options: {
			org?: string;
			projectId?: string;
			search?: string;
			limit?: number;
			offset?: number;
		} = {},
	) {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(options)) {
			if (value !== undefined) {
				params.set(key, String(value));
			}
		}
		return this.http.get<{
			instances: Array<{
				id: string;
				name: string;
				[key: string]: unknown;
			}>;
			total: number;
			hasMore: boolean;
		}>(`/reports/instances${params.size ? `?${params}` : ""}`);
	}
	createInstance(input: ReportSettings, options: { org?: string } = {}) {
		return this.http.post<{ id: string; version: number; name: string }>(
			`/reports/instances${orgQuery(options.org)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	getInstance(id: string, options: { org?: string } = {}) {
		return this.http.get<ConfiguredReport>(
			`/reports/instances/${encodeURIComponent(id)}${orgQuery(options.org)}`,
		);
	}
	configureInstance(
		id: string,
		input: ReportConfigurationUpdate,
		options: { org?: string } = {},
	) {
		return this.http.patch<{
			id: string;
			version: number;
			updatedAt: string;
		}>(
			`/reports/instances/${encodeURIComponent(id)}${orgQuery(options.org)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	executeInstance(
		id: string,
		input: { idempotencyKey: string; parameters?: Record<string, unknown> },
		options: { org?: string } = {},
	) {
		return this.http.post<{
			executionId: string;
			workflowId: string;
			status: string;
			startConfirmed: boolean;
			message: string;
		}>(
			`/reports/instances/${encodeURIComponent(id)}/executions${orgQuery(options.org)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	getExecution(id: string, options: { org?: string } = {}) {
		return this.http.get<ReportExecutionStatus>(
			`/reports/executions/${encodeURIComponent(id)}${orgQuery(options.org)}`,
		);
	}
	cancelExecution(id: string, options: { org?: string } = {}) {
		return this.http.post<{ cancelled: boolean }>(
			`/reports/executions/${encodeURIComponent(id)}/cancel${orgQuery(options.org)}`,
			{},
			{ retry: { maxRetries: 0 } },
		);
	}
	downloadArtifact(id: string, options: { org?: string } = {}) {
		return this.http.get<ReportArtifactDownload>(
			`/reports/artifacts/${encodeURIComponent(id)}/download${orgQuery(options.org)}`,
		);
	}
	distributeArtifact(
		id: string,
		input: ReportDistributionInput,
		options: { org?: string } = {},
	) {
		return this.http.post<ReportDistributionReceipt>(
			`/reports/artifacts/${encodeURIComponent(id)}/distribute${orgQuery(options.org)}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	getArtifactDeliveries(id: string, options: { org?: string } = {}) {
		return this.http.get<{
			sends: unknown[];
			total: number;
			hasMore: boolean;
			inboxDeliveries: unknown[];
		}>(
			`/reports/artifacts/${encodeURIComponent(id)}/deliveries${orgQuery(options.org)}`,
		);
	}

	branding(options: { org?: string; projectId?: string } = {}) {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.projectId) {
			params.set("projectId", options.projectId);
		}
		return this.http.get<ArtifactBrandChoices>(
			`/reports/branding${params.size ? `?${params}` : ""}`,
		);
	}

	getInstanceBranding(id: string, options: { org?: string } = {}) {
		return this.http.get<ReportInstanceBrandingChoices>(
			`/reports/instances/${encodeURIComponent(id)}/branding${options.org ? `?${new URLSearchParams({ org: options.org })}` : ""}`,
		);
	}
	applyInstanceBranding(
		id: string,
		input: ReportInstanceBrandingUpdate,
		options: { org?: string } = {},
	) {
		return this.http.put<ReportInstanceBrandingResult>(
			`/reports/instances/${encodeURIComponent(id)}/branding${options.org ? `?${new URLSearchParams({ org: options.org })}` : ""}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
	listTemplates(
		options: ListReportTemplatesOptions = {},
	): Promise<FabricReportTemplate[]> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		if (options.limit !== undefined) {
			params.set("limit", String(options.limit));
		}
		if (options.offset !== undefined) {
			params.set("offset", String(options.offset));
		}
		if (options.search) {
			params.set("search", options.search);
		}
		if (options.category) {
			params.set("category", options.category);
		}
		const qs = params.toString();
		return this.http.get<FabricReportTemplate[]>(
			`/reports/templates${qs ? `?${qs}` : ""}`,
		);
	}

	getTemplate(
		id: string,
		options: { org?: string; personal?: boolean } = {},
	): Promise<FabricReportTemplate> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.get<FabricReportTemplate>(
			`/reports/templates/${id}${qs ? `?${qs}` : ""}`,
		);
	}

	listInstanceExecutions(
		instanceId: string,
		options: ListReportInstanceExecutionsOptions = {},
	): Promise<{
		executions: ReportHistoryExecution[];
		hasMore: boolean;
		nextCursor: string | null;
	}> {
		const filters = options;
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(filters)) {
			if (value !== undefined) {
				params.set(key, String(value));
			}
		}
		return this.http.get(
			`/reports/instances/${encodeURIComponent(instanceId)}/executions${params.size ? `?${params}` : ""}`,
		);
	}
	listArtifacts(
		executionId: string,
		options: {
			org?: string;
			limit?: number;
			cursor?: string;
			artifactType?: string;
		} = {},
	): Promise<{
		artifacts: ReportArtifactReference[];
		hasMore: boolean;
		nextCursor: string | null;
	}> {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(options)) {
			if (value !== undefined) {
				params.set(key, String(value));
			}
		}
		return this.http.get(
			`/reports/executions/${encodeURIComponent(executionId)}/artifacts${params.size ? `?${params}` : ""}`,
		);
	}
	/** @deprecated Legacy executions; native configured reports use listInstanceExecutions. */
	listExecutions(
		options: ListReportExecutionsOptions = {},
	): Promise<FabricReportExecution[]> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		if (options.limit !== undefined) {
			params.set("limit", String(options.limit));
		}
		if (options.offset !== undefined) {
			params.set("offset", String(options.offset));
		}
		if (options.status) {
			params.set("status", options.status);
		}
		if (options.templateId) {
			params.set("templateId", options.templateId);
		}
		const qs = params.toString();
		return this.http.get<FabricReportExecution[]>(
			`/reports/executions${qs ? `?${qs}` : ""}`,
		);
	}
}
