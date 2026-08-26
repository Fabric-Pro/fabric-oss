import type { FabricHttpClient } from "../client.js";
import type { FabricFrame, ListOptions } from "../types.js";

export interface ListFramesOptions extends ListOptions {
	status?: string;
}

export class FramesResource {
	constructor(private readonly http: FabricHttpClient) {}

	list(options: ListFramesOptions = {}): Promise<FabricFrame[]> {
		const q = buildQuery(options);
		return this.http.get<FabricFrame[]>(`/frames${q}`);
	}

	get(
		id: string,
		options: { org?: string; personal?: boolean } = {},
	): Promise<FabricFrame> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const q = params.toString() ? `?${params.toString()}` : "";
		return this.http.get<FabricFrame>(`/frames/${id}${q}`);
	}
}

function buildQuery(opts: object): string {
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(opts)) {
		if (v !== undefined && v !== null) {
			params.set(k, k === "personal" ? (v ? "1" : "") : String(v));
		}
	}
	const s = params.toString();
	return s ? `?${s}` : "";
}
