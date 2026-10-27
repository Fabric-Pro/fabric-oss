import { orpcClient } from "@shared/lib/orpc-client";
import type { QueryClient } from "@tanstack/react-query";
import {
	dismissSyncError,
	executeWithRetry,
	showSyncError,
	showSyncSuccess,
} from "../hooks/useAgentConfigPersistence";
import { setCachedOrchestratorPreferenceLists } from "./interface-mode-preference";

const PREFERENCE_FIELDS = [
	"enabledMcpConfigIds",
	"enabledAgentIds",
	"enabledWorkspaceIds",
] as const;
export type OrchestratorPreferenceFields = Partial<
	Record<(typeof PREFERENCE_FIELDS)[number], string[]>
>;
type Owner = { userId: string; organizationId: string };
type Status = "idle" | "syncing" | "error" | "success" | "dropped";
type SessionUserGetter = () => string | undefined;
type Queue = {
	pending: OrchestratorPreferenceFields;
	inFlight: boolean;
	inFlightFields: OrchestratorPreferenceFields | null;
	flushWanted: boolean;
	status: Status;
	getSessionUserId: SessionUserGetter;
	queryClient: QueryClient;
	listeners: Set<(status: Status) => void>;
};

// Shared across mounts: a key's backoff, pending edits and drains outlive subscribers.
const queues = new Map<string, Queue>();
const keyFor = (owner: Owner) => `${owner.userId}:${owner.organizationId}`;
const hasFields = (fields: OrchestratorPreferenceFields) =>
	PREFERENCE_FIELDS.some((field) => fields[field] !== undefined);

function getQueue(
	owner: Owner,
	getSessionUserId: SessionUserGetter,
	queryClient: QueryClient,
): Queue {
	const key = keyFor(owner);
	let queue = queues.get(key);
	if (!queue) {
		queue = {
			pending: {},
			inFlight: false,
			inFlightFields: null,
			flushWanted: false,
			status: "idle",
			getSessionUserId,
			queryClient,
			listeners: new Set(),
		};
		queues.set(key, queue);
	}
	queue.getSessionUserId = getSessionUserId;
	queue.queryClient = queryClient;
	return queue;
}

function notify(queue: Queue, status: Status) {
	queue.status = status;
	for (const listener of queue.listeners) {
		listener(status);
	}
}

export function subscribeOrchestratorPreferenceSaveQueue(
	owner: Owner,
	getSessionUserId: SessionUserGetter,
	listener: (status: Status) => void,
	queryClient: QueryClient,
): () => void {
	const queue = getQueue(owner, getSessionUserId, queryClient);
	queue.listeners.add(listener);
	listener(queue.status);
	return () => {
		queue.listeners.delete(listener);
	};
}

export function enqueueOrchestratorPreferences(
	owner: Owner,
	fields: OrchestratorPreferenceFields,
	getSessionUserId: SessionUserGetter,
	queryClient: QueryClient,
): void {
	const queue = getQueue(owner, getSessionUserId, queryClient);
	queue.pending = { ...queue.pending, ...fields };
	if (queue.status === "success" || queue.status === "dropped") {
		notify(queue, "idle");
	}
}

// Pending edits win over the batch still sending or waiting in retry backoff.
export function getUnsentOrchestratorPreferences(
	owner: Owner,
): OrchestratorPreferenceFields {
	const queue = queues.get(keyFor(owner));
	return { ...queue?.inFlightFields, ...queue?.pending };
}

export async function flushOrchestratorPreferences(
	owner: Owner,
): Promise<void> {
	const key = keyFor(owner);
	const queue = queues.get(key);
	if (!queue) {
		return;
	}
	if (queue.inFlight) {
		queue.flushWanted = true;
		return;
	}
	if (!hasFields(queue.pending)) {
		return;
	}
	// No per-request timeout: an abandoned request could still land after a newer
	// send, so a request that never settles holds this key's queue instead.
	const fields = queue.pending;
	queue.inFlightFields = fields;
	queue.pending = {};
	queue.inFlight = true;
	notify(queue, "syncing");
	let outcome: "sent" | "superseded" | "dropped" | "failed";
	try {
		outcome = await executeWithRetry(
			async () => {
				if (
					queues.get(key) !== queue ||
					queue.getSessionUserId() !== owner.userId
				) {
					return "dropped" as const;
				}
				for (const field of PREFERENCE_FIELDS) {
					if (queue.pending[field] !== undefined) {
						delete fields[field];
					}
				}
				if (!hasFields(fields)) {
					return "superseded" as const;
				}
				await orpcClient.users.orchestratorPreferences.update({
					organizationId: owner.organizationId,
					...fields,
				});
				return "sent" as const;
			},
			{ maxRetries: 3, baseDelayMs: 1000 },
		);
	} catch (error) {
		outcome = "failed";
		console.error(
			"[OrchestratorConfig] Database sync failed after retries:",
			error,
		);
	}
	if (
		outcome === "sent" &&
		queues.get(key) === queue &&
		queue.getSessionUserId() === owner.userId
	) {
		try {
			await setCachedOrchestratorPreferenceLists(
				queue.queryClient,
				owner.organizationId,
				fields,
				() =>
					queues.get(key) === queue &&
					queue.getSessionUserId() === owner.userId,
			);
		} catch (error) {
			console.error(
				"[OrchestratorConfig] Preferences cache update failed:",
				error,
			);
		}
	}
	// A reset must also retire already-running test batches.
	if (queues.get(key) !== queue) {
		return;
	}
	queue.inFlight = false;
	queue.inFlightFields = null;
	const flushWanted = queue.flushWanted;
	queue.flushWanted = false;
	if (outcome === "dropped" || queue.getSessionUserId() !== owner.userId) {
		queue.pending = {};
		dismissSyncError(key);
		notify(queue, "dropped");
		return;
	}
	if (outcome === "failed") {
		queue.pending = { ...fields, ...queue.pending };
		notify(queue, "error");
		if (hasFields(queue.pending)) {
			showSyncError(
				"Failed to save settings",
				"Your latest changes haven't been saved. Select Retry to send them again.",
				() => void flushOrchestratorPreferences(owner),
				key,
			);
		}
	} else if (outcome === "sent" && !hasFields(queue.pending)) {
		notify(queue, "success");
		showSyncSuccess(key);
	} else {
		notify(queue, "idle");
	}
	// Only an explicit drain request can restart a failed send; failures never loop.
	if (flushWanted) {
		await flushOrchestratorPreferences(owner);
	}
}

export function resetOrchestratorPreferenceSaveQueueForTests(): void {
	for (const key of queues.keys()) {
		dismissSyncError(key);
	}
	queues.clear();
}
