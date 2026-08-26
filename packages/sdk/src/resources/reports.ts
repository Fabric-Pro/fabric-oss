import type { FabricHttpClient } from "../client.js";
import type { FabricReportExecution, FabricReportTemplate } from "../types.js";

export interface ListReportTemplatesOptions {
	org?: string;
	personal?: boolean;
	limit?: number;
	offset?: number;
	search?: string;
	category?: string;
}

export interface ListReportExecutionsOptions {
	org?: string;
	personal?: boolean;
	limit?: number;
	offset?: number;
}

export class ReportsResource {
	constructor(private readonly http: FabricHttpClient) {}

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
		const qs = params.toString();
		return this.http.get<FabricReportExecution[]>(
			`/reports/executions${qs ? `?${qs}` : ""}`,
		);
	}
}
