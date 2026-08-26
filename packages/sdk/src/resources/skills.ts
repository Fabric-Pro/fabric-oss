import type { FabricHttpClient } from "../client.js";
import type { FabricSkill, ListOptions } from "../types.js";

export interface ListSkillsOptions extends ListOptions {
	category?: string;
}

export class SkillsResource {
	constructor(private readonly http: FabricHttpClient) {}

	list(options: ListSkillsOptions = {}): Promise<FabricSkill[]> {
		const q = buildQuery(options);
		return this.http.get<FabricSkill[]>(`/skills${q}`);
	}

	get(id: string): Promise<FabricSkill> {
		return this.http.get<FabricSkill>(`/skills/${id}`);
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
