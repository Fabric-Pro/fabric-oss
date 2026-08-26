import type { FabricHttpClient } from "../client.js";
import type {
	FabricMcpConfig,
	FabricMcpConfigDetail,
	FabricMcpServer,
} from "../types.js";

export interface ListMcpOptions {
	org?: string;
	personal?: boolean;
}

export class McpResource {
	constructor(private readonly http: FabricHttpClient) {}

	async listServers(
		options: ListMcpOptions = {},
	): Promise<FabricMcpServer[]> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.get<FabricMcpServer[]>(
			`/mcp/servers${qs ? `?${qs}` : ""}`,
		);
	}

	async listConfigs(
		options: ListMcpOptions = {},
	): Promise<FabricMcpConfig[]> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.get<FabricMcpConfig[]>(
			`/mcp/configs${qs ? `?${qs}` : ""}`,
		);
	}

	async getConfig(
		id: string,
		options: ListMcpOptions = {},
	): Promise<FabricMcpConfigDetail> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.get<FabricMcpConfigDetail>(
			`/mcp/configs/${id}${qs ? `?${qs}` : ""}`,
		);
	}

	async deleteConfig(
		id: string,
		options: ListMcpOptions = {},
	): Promise<{ id: string; deleted: boolean }> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.delete<{ id: string; deleted: boolean }>(
			`/mcp/configs/${id}${qs ? `?${qs}` : ""}`,
		);
	}
}
