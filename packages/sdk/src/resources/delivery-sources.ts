import type { FabricHttpClient } from "../client.js";

export interface DeliverySourceWatch {
	id: string;
	provider: "SLACK";
	label: string;
	state: "ACTIVE" | "PAUSED" | "DISCONNECTED";
	version: number;
	visibility: "ONLY_ME";
	retentionDays: 7 | 30;
	verifiedAt: string;
	createdAt: string;
	lastRequestId: string | null;
	lastCaptureInput: {
		requestId: string;
		expectedVersion: number;
		mode: "RECENT" | "CONTINUE" | "BACKFILL";
		window?: { start: string; end: string };
	} | null;
	hasMore: boolean;
	captureWindow: { start: string; end: string; complete: boolean } | null;
}
export type DeliverySourceAvailability =
	| { state: "ENABLED"; reason: null }
	| { state: "UNAVAILABLE"; reason: "NOT_ENABLED" | "STORAGE_UNAVAILABLE" };
export interface DeliverySourceList {
	version: 1;
	/** Operator/storage state only; not source connectivity or provider health. */
	availability: DeliverySourceAvailability;
	watches: DeliverySourceWatch[];
	connections: {
		id: string;
		name: string;
		supportsPrivateCapture: boolean;
	}[];
}
export interface DeliverySourceInspection {
	version: 1;
	provider: "SLACK";
	label: string;
	visibility: "ONLY_ME";
	checkedAt: string;
	coverage: "ROOT_MESSAGES_ONLY";
}
export interface DeliverySourceRun {
	/** Native fencing readiness only; a new request independently checks current write/source access. */
	canStartNewCapture?: boolean;
	version: 1;
	state:
		| "NOT_STARTED"
		| "RUNNING"
		| "COMPLETED"
		| "FAILED"
		| "CANCELLED"
		| "OUTCOME_UNKNOWN";
	requestId: string | null;
	coverage: "ROOT_MESSAGES_ONLY" | "PARTIAL" | null;
	captured: number | null;
	hasMore: boolean;
	message: string | null;
}
export interface DeliverySourceObservation {
	id: string;
	capturedAt: string;
	expiresAt: string;
	change: "UPSERT" | "DELETE";
	hasConflict: boolean;
	coverage: "ROOT_MESSAGES_ONLY";
}
export interface DeliverySourceObservationPage {
	version: 1;
	items: DeliverySourceObservation[];
	nextCursor: string | null;
}
export interface DeliverySourceEvidence {
	version: 1;
	observationId: string;
	text: string;
	capturedAt: string;
	checkedAt: string;
	coverage: "ROOT_MESSAGES_ONLY";
	visibility: "ONLY_ME";
}
export interface DeliverySourceContext {
	org?: string;
}
export interface DeliverySourceSelection extends DeliverySourceContext {
	integrationId: string;
	channelId: string;
}
export interface ConfigureDeliverySourceOptions
	extends DeliverySourceSelection {
	requestId: string;
	retentionDays?: 7 | 30;
}
export interface DeliverySourceMutationOptions extends DeliverySourceContext {
	requestId: string;
	expectedVersion: number;
}
export interface CaptureDeliverySourceOptions
	extends DeliverySourceMutationOptions {
	mode?: "RECENT" | "CONTINUE" | "BACKFILL";
	window?: { start: string; end: string };
}
export interface DeliverySourceObservationOptions
	extends DeliverySourceContext {
	cursor?: string;
	limit?: number;
}
function path(
	projectId: string,
	suffix: string,
	options: DeliverySourceContext = {},
) {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) {
			query.set(key, String(value));
		}
	}
	return `/projects/${encodeURIComponent(projectId)}/delivery/private-sources${suffix}${query.size ? `?${query}` : ""}`;
}
/** Supply the SAME requestId and original input on retries, including after a lost response. */
export function deliverySourceMethods(http: FabricHttpClient) {
	const watch = (id: string) => `/${encodeURIComponent(id)}`;
	const state = (
		action: "PAUSE" | "RESUME" | "DISCONNECT",
		projectId: string,
		watchId: string,
		options: DeliverySourceMutationOptions,
	): Promise<DeliverySourceWatch> => {
		const { org, ...body } = options;
		return http.post(
			path(projectId, `${watch(watchId)}/state`, { org }),
			{ ...body, action },
			{ idempotencyKey: body.requestId },
		);
	};
	return {
		listDeliverySources(
			projectId: string,
			options: DeliverySourceContext = {},
		): Promise<DeliverySourceList> {
			return http.get(path(projectId, "", options));
		},
		testDeliverySource(
			projectId: string,
			options: DeliverySourceSelection,
		): Promise<DeliverySourceInspection> {
			const { org, ...body } = options;
			return http.post(path(projectId, "/inspect", { org }), body, {
				retry: { maxRetries: 0 },
			});
		},
		configureDeliverySource(
			projectId: string,
			options: ConfigureDeliverySourceOptions,
		): Promise<DeliverySourceWatch> {
			const { org, ...body } = options;
			return http.post(path(projectId, "", { org }), body, {
				idempotencyKey: body.requestId,
			});
		},
		pauseDeliverySource(
			projectId: string,
			watchId: string,
			options: DeliverySourceMutationOptions,
		) {
			return state("PAUSE", projectId, watchId, options);
		},
		resumeDeliverySource(
			projectId: string,
			watchId: string,
			options: DeliverySourceMutationOptions,
		) {
			return state("RESUME", projectId, watchId, options);
		},
		disconnectDeliverySource(
			projectId: string,
			watchId: string,
			options: DeliverySourceMutationOptions,
		) {
			return state("DISCONNECT", projectId, watchId, options);
		},
		startDeliverySourceCapture(
			projectId: string,
			watchId: string,
			options: CaptureDeliverySourceOptions,
		): Promise<DeliverySourceRun> {
			const { org, ...body } = options;
			return http.post(
				path(projectId, `${watch(watchId)}/capture`, { org }),
				body,
				{ idempotencyKey: body.requestId },
			);
		},
		getDeliverySourceCapture(
			projectId: string,
			watchId: string,
			options: DeliverySourceContext = {},
		): Promise<DeliverySourceRun> {
			return http.get(
				path(projectId, `${watch(watchId)}/capture`, options),
			);
		},
		cancelDeliverySourceCapture(
			projectId: string,
			watchId: string,
			options: DeliverySourceContext & { requestId: string },
		): Promise<DeliverySourceRun> {
			const { org, ...body } = options;
			return http.post(
				path(projectId, `${watch(watchId)}/capture/cancel`, { org }),
				body,
				{ idempotencyKey: body.requestId },
			);
		},
		listDeliverySourceObservations(
			projectId: string,
			watchId: string,
			options: DeliverySourceObservationOptions = {},
		): Promise<DeliverySourceObservationPage> {
			return http.get(
				path(projectId, `${watch(watchId)}/observations`, options),
			);
		},
		getDeliverySourceEvidence(
			projectId: string,
			watchId: string,
			observationId: string,
			options: DeliverySourceContext = {},
		): Promise<DeliverySourceEvidence> {
			return http.get(
				path(
					projectId,
					`${watch(watchId)}/observations/${encodeURIComponent(observationId)}`,
					options,
				),
			);
		},
	};
}
