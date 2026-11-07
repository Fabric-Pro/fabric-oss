import type { FabricHttpClient } from "../client.js";

export type DeliverySignalProvider =
	| "SLACK"
	| "TEAMS"
	| "JIRA"
	| "AZURE_DEVOPS"
	| "FIZZY";
/** A saved project work item, not a raw message, pending proposal or live source event. */
export interface DeliverySignalRecord {
	id: string;
	identifier: string;
	title: string;
	source: DeliverySignalProvider;
	kind: "PROJECT_WORK_ITEM";
	draftingStage:
		| "PLACEHOLDER"
		| "PASSIVE_ANALYSIS"
		| "ACTIVE_ANALYSIS"
		| "SANITY_CHECK"
		| "DRAFT"
		| "PUBLISHED"
		| "CLOSED";
	createdAt: string;
	href: string;
}
export interface DeliverySignalPage {
	version: 1;
	coverage: "PROJECT_WORK_ITEMS_ONLY";
	items: DeliverySignalRecord[];
	nextCursor: string | null;
}
export interface DeliverySignalSourceConfiguration {
	version: 1;
	items: {
		source: DeliverySignalProvider;
		state: "NOT_CONFIGURED" | "CONFIGURED_NOT_CHECKED" | "PAUSED";
	}[];
}
export interface ListDeliverySignalsOptions {
	org?: string;
	source?: DeliverySignalProvider;
	search?: string;
	limit?: number;
	/** Reuse only with the same actor, project and filters. */
	cursor?: string;
}
function path(projectId: string, suffix: string, options: object) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) {
			params.set(key, String(value));
		}
	}
	return `/projects/${encodeURIComponent(projectId)}/delivery/${suffix}${params.size ? `?${params}` : ""}`;
}
export function deliverySignalMethods(http: FabricHttpClient) {
	return {
		listDeliverySignals(
			projectId: string,
			options: ListDeliverySignalsOptions = {},
		): Promise<DeliverySignalPage> {
			return http.get(path(projectId, "signals", options));
		},
		getDeliverySignal(
			projectId: string,
			id: string,
			options: { org?: string } = {},
		): Promise<DeliverySignalRecord> {
			return http.get(
				path(projectId, `signals/${encodeURIComponent(id)}`, options),
			);
		},
		getDeliverySignalSourceConfiguration(
			projectId: string,
			options: { org?: string } = {},
		): Promise<DeliverySignalSourceConfiguration> {
			return http.get(path(projectId, "sources", options));
		},
	};
}
