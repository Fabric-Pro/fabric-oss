import type { FabricHttpClient } from "../client.js";

export type DashboardCuratedFeedbackAction =
	| "click"
	| "pin"
	| "unpin"
	| "dismiss"
	| "restore";

export interface DashboardCuratedPreference {
	cardKey: string;
	pinnedAt: string | null;
	dismissedAt: string | null;
	clickCount: number;
	lastClickedAt: string | null;
	updatedAt: string;
}

export interface DashboardCuratedFeedbackInput {
	cardKey: string;
	action: DashboardCuratedFeedbackAction;
}

export interface DashboardOptions {
	org?: string;
	personal?: boolean;
}

function tenantQuery(options: DashboardOptions): string {
	const params = new URLSearchParams();
	if (options.org) {
		params.set("org", options.org);
	}
	if (options.personal) {
		params.set("personal", "1");
	}
	const query = params.toString();
	return query ? `?${query}` : "";
}

export class DashboardResource {
	constructor(private readonly http: FabricHttpClient) {}

	listCuratedFeedback(options: DashboardOptions = {}): Promise<{
		preferences: DashboardCuratedPreference[];
	}> {
		return this.http.get(
			`/dashboard/curated-feedback${tenantQuery(options)}`,
		);
	}

	recordCuratedFeedback(
		input: DashboardCuratedFeedbackInput,
		options: DashboardOptions = {},
	): Promise<{ preference: DashboardCuratedPreference }> {
		return this.http.request(
			"POST",
			`/dashboard/curated-feedback${tenantQuery(options)}`,
			{ body: input, retry: { maxRetries: 0 } },
		);
	}
}
