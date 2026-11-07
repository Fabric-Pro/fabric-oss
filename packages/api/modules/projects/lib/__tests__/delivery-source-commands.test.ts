import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { Permissions } from "@repo/permissions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	availability: vi.fn(),
	ready: vi.fn(),
	project: vi.fn(),
	member: vi.fn(),
	edit: vi.fn(),
	effective: vi.fn(),
	watches: vi.fn(),
	integrations: vi.fn(),
	watch: vi.fn(),
	command: vi.fn(),
	last: vi.fn(),
	captureByWorkflow: vi.fn(),
	cancellation: vi.fn(),
	configure: vi.fn(),
	state: vi.fn(),
	admit: vi.fn(),
	cancelIntent: vi.fn(),
	observations: vi.fn(),
	observation: vi.fn(),
	inspect: vi.fn(),
	pinned: vi.fn(),
	qualify: vi.fn(),
	exact: vi.fn(),
	pair: vi.fn(),
	decrypt: vi.fn(),
	describe: vi.fn(),
	namespace: vi.fn(),
	start: vi.fn(),
	result: vi.fn(),
	cancel: vi.fn(),
	client: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	DeliverySourceStoreError: class extends Error {
		constructor(readonly code: string) {
			super("private-store-detail");
		}
	},
	canEditProject: m.edit,
	db: { member: { findUnique: m.member } },
	listOwnedDeliverySourceWatches: m.watches,
	listOwnedDeliverySlackIntegrations: m.integrations,
	getOwnedDeliverySourceWatch: m.watch,
	getOwnedDeliverySourceCommand: m.command,
	getLastOwnedDeliverySourceCaptureCommand: m.last,
	getOwnedDeliverySourceCaptureCommandByWorkflowId: m.captureByWorkflow,
	getOwnedDeliverySourceCaptureCancellation: m.cancellation,
	configureDeliverySourceWatch: m.configure,
	changeDeliverySourceWatchState: m.state,
	prepareDeliverySourceCaptureCommand: m.admit,
	prepareDeliverySourceCancelCommand: m.cancelIntent,
	listOwnedDeliverySourceObservations: m.observations,
	getOwnedDeliverySourceObservation: m.observation,
}));
vi.mock("../delivery-signals", () => ({
	requireDeliverySignalProjectAccess: m.project,
	deliverySignalPermissionDenied: () => {
		throw new ORPCError("FORBIDDEN", {
			message: "Current access refused.",
			data: { code: "INSUFFICIENT_PERMISSION" },
		});
	},
}));
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.effective,
}));
vi.mock("@repo/temporal/delivery-source-access", async () => {
	const { normalizeDeliverySignalCaptureRevision } = await import(
		"../../../../../connectors/src/delivery-signals/capture-contract"
	);
	return {
		DeliverySourceAccessError: class extends Error {},
		DELIVERY_SOURCE_ADAPTER_VERSION: "slack-private-roots-v1",
		inspectOwnedSlackDeliveryIntegration: m.inspect,
		loadPinnedSlackDeliveryCredentials: m.pinned,
		savedSlackDeliveryCredentialPairAvailable: m.pair,
		encodeDeliverySourceSnapshot: (message: {
			externalItemId: string;
			revision: unknown;
			text: string;
			hasReplies: boolean;
		}) => {
			const payload = JSON.stringify({
				version: 1,
				provider: "SLACK",
				externalItemId: message.externalItemId,
				revision: normalizeDeliverySignalCaptureRevision(
					message.revision,
				),
				text: message.text,
				hasReplies: message.hasReplies,
			});
			return {
				payload,
				digest: createHash("sha256").update(payload).digest("hex"),
			};
		},
	};
});
vi.mock("@repo/temporal/client", () => ({ getTemporalClient: m.client }));
vi.mock("@repo/temporal/delivery-source-readiness", () => ({
	getPrivateDeliverySourceAvailability: m.availability,
	requirePrivateDeliverySourceAvailability: m.ready,
	PrivateDeliverySourceUnavailableError: class extends Error {
		readonly code = "PRIVATE_SOURCE_CAPTURE_UNAVAILABLE";
		constructor(readonly reason: string) {
			super("Private capture unavailable");
		}
	},
}));
vi.mock("@repo/utils", () => ({
	isEncryptedApiKey: (value: unknown) =>
		typeof value === "string" && value.startsWith("encrypted:"),
	decryptApiKey: m.decrypt,
}));
vi.mock("@repo/connectors", async () => {
	const { normalizeDeliverySignalCaptureRevision } = await import(
		"../../../../../connectors/src/delivery-signals/capture-contract"
	);
	return {
		normalizeDeliverySignalCaptureRevision,
		SlackDeliveryCaptureError: class extends Error {
			constructor(readonly code: string) {
				super("private-provider-detail");
			}
		},
		qualifySlackDeliverySource: m.qualify,
		readExactSlackDeliveryMessage: m.exact,
	};
});
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(value: T) => value,
}));

import {
	cancelDeliverySourceCapture,
	configureDeliverySource,
	getDeliverySourceCaptureStatus,
	getDeliverySourceEvidence,
	listDeliverySourceObservations,
	listDeliverySourceWatches,
	requirePrivateDeliverySourceEvidenceAccess,
	startDeliverySourceCapture,
	updateDeliverySourceState,
} from "../delivery-source-commands";

const now = new Date("2026-11-01T12:00:00Z");
const scope = {
	organizationId: "example-org",
	projectId: "example-project",
	userId: "example-user",
};
const actor = { userId: scope.userId };
const requestId = "11111111-1111-4111-8111-111111111111";
const capture = {
	projectId: scope.projectId,
	watchId: "example-watch",
	requestId,
	expectedVersion: 3,
	mode: "RECENT" as const,
};
const hash = (op: string, input: unknown) =>
	createHash("sha256")
		.update(JSON.stringify([1, op, input]))
		.digest("hex");
const namespaceId = "44444444-4444-4444-8444-444444444444";
const routingDigest = hash("NATIVE_ROUTING", [
	"temporal.example.com:7233",
	"example-namespace",
	namespaceId,
]);
const nativeId = `delivery-source-${hash("NATIVE_CAPTURE", [scope.organizationId, scope.projectId, scope.userId, capture.watchId, requestId, routingDigest])}`;
const receipt = {
	...scope,
	id: "example-command",
	watchId: capture.watchId,
	requestId,
	operation: "CAPTURE",
	payloadHash: hash("CAPTURE", capture),
	expectedVersion: 3,
	grantRevision: 2,
	captureMode: "RECENT",
	workflowId: nativeId,
	createdAt: now,
};
const watch = {
	...scope,
	id: capture.watchId,
	provider: "SLACK",
	installationId: "T123",
	containerId: "C123",
	label: "Slack channel",
	state: "ACTIVE",
	version: 3,
	grantRevision: 2,
	retentionDays: 7,
	verifiedAt: now,
	createdAt: now,
	lastRequestId: requestId,
	lastWorkflowId: nativeId,
	captureWindowStart: now,
	captureComplete: false,
};
const grant = {
	id: "example-grant",
	revision: 2,
	botUserId: "U123",
	humanUserId: "U456",
	adapterVersion: "slack-private-roots-v1",
	botId: "B123",
	revokedAt: null,
};
const pinned = {
	context: {
		watch,
		grant,
		integration: {
			id: "example-integration",
			credentials: "encrypted:private",
		},
	},
	adapterInput: {
		botToken: "private-bot",
		userToken: "private-human",
		expectedTeamId: "T123",
		channelId: "C123",
		expectedHumanUserId: "U456",
		expectedBotId: "B123",
	},
};
const nativeMemo = {
	version: 1,
	routingDigest,
	...scope,
	watchId: watch.id,
	requestId,
	payloadHash: receipt.payloadHash,
	configVersion: 3,
	grantRevision: 2,
	mode: "RECENT",
};
const description = {
	type: "deliverySourceCaptureWorkflow",
	runId: "22222222-2222-4222-8222-222222222222",
	memo: { fabricDeliverySourceCapture: nativeMemo },
	status: { name: "RUNNING" },
};
const message = {
	occurredAt: now.toISOString(),
	externalItemId: "1762000000.123456",
	revision: { kind: "DECIMAL", value: "1762000000.123456" },
	text: "Private source text",
	hasReplies: false,
};
const payload = JSON.stringify({
	version: 1,
	provider: "SLACK",
	externalItemId: message.externalItemId,
	revision: message.revision,
	text: message.text,
	hasReplies: message.hasReplies,
});
const observation = {
	...scope,
	id: "example-observation",
	watchId: watch.id,
	externalItemId: message.externalItemId,
	revisionKind: "DECIMAL",
	revisionValue: message.revision.value,
	ciphertext: "encrypted:evidence",
	evidenceDigest: createHash("sha256").update(payload).digest("hex"),
	capturedAt: now,
	expiresAt: new Date(now.getTime() + 3_600_000),
	hasConflict: false,
	change: "UPSERT",
};
const client = {
	workflow: {
		connection: { options: { address: "temporal.example.com:7233" } },
		options: { namespace: "example-namespace" },
		withDeadline: async <T>(_deadline: number, work: () => Promise<T>) =>
			work(),
		workflowService: { describeNamespace: m.namespace },
		getHandle: () => ({ describe: m.describe, cancel: m.cancel }),
		start: m.start,
		result: m.result,
	},
};
function notFound() {
	return Object.assign(new Error("private-native-message"), {
		name: "WorkflowNotFoundError",
	});
}
beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
	m.availability.mockResolvedValue({ state: "ENABLED", reason: null });
	m.ready.mockResolvedValue(undefined);
	m.project.mockResolvedValue(scope);
	m.member.mockResolvedValue({ role: "owner" });
	m.edit.mockResolvedValue(true);
	m.effective.mockResolvedValue({
		organizationId: scope.organizationId,
		permissions: [Permissions.PROJECT_UPDATE, Permissions.STORY_UPDATE],
	});
	m.watch.mockResolvedValue(watch);
	m.watches.mockResolvedValue([{ ...watch, lastCaptureCommand: receipt }]);
	m.integrations.mockResolvedValue([
		{
			id: "example-integration",
			name: "Private connection",
			credentials: "encrypted:secret",
		},
	]);
	m.pair.mockReturnValue(true);
	m.cancellation.mockResolvedValue(null);
	m.command.mockResolvedValue(null);
	m.last.mockResolvedValue(null);
	m.pinned.mockResolvedValue(pinned);
	m.qualify.mockResolvedValue({
		teamId: "T123",
		channelId: "C123",
		humanUserId: "U456",
		botId: "B123",
		botUserId: "U123",
	});
	m.client.mockResolvedValue(client);
	m.describe.mockRejectedValue(notFound());
	m.namespace.mockResolvedValue({
		namespaceInfo: { name: "example-namespace", id: namespaceId },
		config: { workflowExecutionRetentionTtl: { seconds: 3600, nanos: 0 } },
	});
	m.admit.mockResolvedValue({ receipt, watch, grant, mayDispatch: true });
	m.result.mockResolvedValue({
		captured: 5,
		hasMore: false,
		coverage: "ROOT_MESSAGES_ONLY",
	});
	m.observation.mockResolvedValue(observation);
	m.exact.mockResolvedValue({
		observedAt: now.toISOString(),
		proof: {
			teamId: "T123",
			channelId: "C123",
			humanUserId: "U456",
			botId: "B123",
			botUserId: grant.botUserId,
		},
		message,
	});
	m.decrypt.mockReturnValue(payload);
	m.observations.mockResolvedValue({ items: [observation], hasMore: false });
});
afterEach(() => vi.useRealTimers());

describe("private source commands — actor and data boundaries", () => {
	it("minimizes owner-only lists without credentials or source prose", async () => {
		const result = await listDeliverySourceWatches(actor, {
			projectId: scope.projectId,
		});
		expect(result.watches[0].lastCaptureInput).toEqual({
			requestId,
			expectedVersion: 3,
			mode: "RECENT",
		});
		expect(result.connections).toEqual([
			{
				id: "example-integration",
				name: "Private connection",
				supportsPrivateCapture: true,
			},
		]);
		expect(JSON.stringify(result)).not.toMatch(
			/encrypted|private-bot|installationId|grantRevision|workflowId/,
		);
		expect(m.watches).toHaveBeenCalledWith(scope);
	});
	it("requires current integration membership before every private read", async () => {
		m.member.mockResolvedValue(null);
		await expect(
			listDeliverySourceWatches(actor, { projectId: scope.projectId }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { code: "INSUFFICIENT_PERMISSION" },
		});
		expect(m.watches).not.toHaveBeenCalled();
	});
	it("rejects supplied actors and retired tenant branches", async () => {
		await expect(
			listDeliverySourceWatches(actor, {
				projectId: scope.projectId,
				userId: "foreign",
			}),
		).rejects.toBeInstanceOf(Error);
		expect(m.project).not.toHaveBeenCalled();
	});
	it("uses exact opaque observation cursors bound to owner, project and watch", async () => {
		m.observations.mockResolvedValue({
			items: [observation],
			hasMore: true,
		});
		const page = await listDeliverySourceObservations(actor, {
			projectId: scope.projectId,
			watchId: watch.id,
			limit: 1,
		});
		expect(page.items[0]).not.toHaveProperty("ciphertext");
		await listDeliverySourceObservations(actor, {
			projectId: scope.projectId,
			watchId: watch.id,
			cursor: page.nextCursor,
		});
		expect(m.observations.mock.lastCall?.[1].cursor).toEqual({
			id: observation.id,
			capturedAt: now,
		});
		await expect(
			listDeliverySourceObservations(actor, {
				projectId: scope.projectId,
				watchId: "another-watch",
				cursor: page.nextCursor,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});
describe("fresh private evidence", () => {
	const input = {
		projectId: scope.projectId,
		watchId: watch.id,
		observationId: observation.id,
	};
	it("decrypts only after exact source, digest, version, grant, expiry and current actor revalidation", async () => {
		const result = await getDeliverySourceEvidence(actor, input);
		expect(result.text).toBe(message.text);
		expect(m.exact).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedHumanUserId: "U456",
				expectedBotId: "B123",
				messageTs: message.externalItemId,
				oldest: message.externalItemId,
				latest: "1762000000.123456001",
			}),
		);
		expect(m.observation).toHaveBeenCalledTimes(2);
		expect(m.pinned).toHaveBeenCalledTimes(2);
		expect(m.decrypt).toHaveBeenCalledOnce();
	});
	it.each([
		"changed-message",
		"expired-during-check",
		"changed-grant",
		"revoked-actor",
		"ciphertext-changed",
	])("never decrypts when %s", async (kind) => {
		if (kind === "changed-message") {
			m.exact.mockResolvedValue({
				observedAt: now.toISOString(),
				proof: {
					teamId: "T123",
					channelId: "C123",
					humanUserId: "U456",
					botId: "B123",
					botUserId: grant.botUserId,
				},
				message: { ...message, text: "Changed source text" },
			});
		}
		if (kind === "expired-during-check") {
			m.observation
				.mockResolvedValueOnce(observation)
				.mockResolvedValueOnce({
					...observation,
					expiresAt: new Date(now.getTime() - 1),
				});
		}
		if (kind === "changed-grant") {
			m.pinned.mockResolvedValueOnce(pinned).mockResolvedValueOnce({
				...pinned,
				context: {
					...pinned.context,
					grant: { ...grant, revision: 3 },
				},
			});
		}
		if (kind === "revoked-actor") {
			m.member
				.mockResolvedValueOnce({ role: "owner" })
				.mockResolvedValueOnce({ role: "owner" })
				.mockResolvedValueOnce(null);
		}
		if (kind === "ciphertext-changed") {
			m.observation
				.mockResolvedValueOnce(observation)
				.mockResolvedValueOnce({
					...observation,
					ciphertext: "encrypted:replaced",
				});
		}
		await expect(
			getDeliverySourceEvidence(actor, input),
		).rejects.toBeInstanceOf(ORPCError);
		expect(m.decrypt).not.toHaveBeenCalled();
	});
	it("never echoes an unexpected dependency failure", async () => {
		m.exact.mockRejectedValue(Error("private-provider-token"));
		await expect(
			getDeliverySourceEvidence(actor, input),
		).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message: "Private sources are temporarily unavailable.",
		});
	});
});
describe("native capture admission and ambiguity", () => {
	it("reattaches an exact completed request without new admission or provider access", async () => {
		m.command.mockResolvedValue(receipt);
		m.describe.mockResolvedValue({
			...description,
			status: { name: "COMPLETED" },
		});
		expect(await startDeliverySourceCapture(actor, capture)).toMatchObject({
			state: "COMPLETED",
			captured: 5,
			requestId,
		});
		expect(m.admit).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
		expect(m.qualify).not.toHaveBeenCalled();
	});
	it("starts only the same immutable identity with REJECT_DUPLICATE and verified minimized memo", async () => {
		m.start.mockImplementation(async () => {
			m.describe.mockResolvedValue(description);
			return {};
		});
		expect(await startDeliverySourceCapture(actor, capture)).toMatchObject({
			state: "RUNNING",
			requestId,
		});
		expect(m.start).toHaveBeenCalledWith(
			"deliverySourceCaptureWorkflow",
			expect.objectContaining({
				workflowId: nativeId,
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				workflowIdConflictPolicy: "USE_EXISTING",
				workflowExecutionTimeout: 900000,
				workflowRunTimeout: 900000,
				memo: { fabricDeliverySourceCapture: nativeMemo },
			}),
		);
		expect(JSON.stringify(m.start.mock.calls)).not.toMatch(
			/private-bot|private-human|Private source text|channelId|temporal\.example\.com/,
		);
	});
	it("preserves unknown after a lost acknowledgement and never invents a replacement request", async () => {
		m.start.mockRejectedValue(Error("private-network-detail"));
		const result = await startDeliverySourceCapture(actor, capture);
		expect(result).toMatchObject({ state: "OUTCOME_UNKNOWN", requestId });
		expect(m.start).toHaveBeenCalledOnce();
		expect(JSON.stringify(result)).not.toContain("private-network-detail");
	});
	it("never dispatches an expired same-request admission even if native history vanished", async () => {
		m.command.mockResolvedValue({
			...receipt,
			createdAt: new Date(now.getTime() - 600_001),
		});
		expect(await startDeliverySourceCapture(actor, capture)).toMatchObject({
			state: "OUTCOME_UNKNOWN",
		});
		expect(m.start).not.toHaveBeenCalled();
		expect(m.namespace).toHaveBeenCalledOnce();
	});
	it("refuses unqualified retention before durable admission", async () => {
		m.namespace.mockResolvedValue({
			config: {
				workflowExecutionRetentionTtl: { seconds: 300, nanos: 0 },
			},
		});
		await expect(
			startDeliverySourceCapture(actor, capture),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(m.admit).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});
	it("does not attach to a colliding wrong memo, even with a matching workflow ID", async () => {
		m.command.mockResolvedValue(receipt);
		m.describe.mockResolvedValue({
			...description,
			memo: {
				fabricDeliverySourceCapture: {
					...nativeMemo,
					userId: "foreign",
				},
			},
		});
		await expect(
			startDeliverySourceCapture(actor, capture),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.start).not.toHaveBeenCalled();
	});
	it("blocks a new request until the old native outcome is established", async () => {
		m.last.mockResolvedValue(receipt);
		m.describe.mockRejectedValue(Error("native unavailable"));
		await expect(
			startDeliverySourceCapture(actor, capture),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "CAPTURE_CONFLICT" },
		});
		expect(m.admit).not.toHaveBeenCalled();
	});
	it("status uncertainty never calls start or mirrors a custom running state", async () => {
		m.last.mockResolvedValue(receipt);
		m.describe.mockRejectedValue(Error("native unavailable"));
		expect(
			await getDeliverySourceCaptureStatus(actor, {
				projectId: scope.projectId,
				watchId: watch.id,
			}),
		).toMatchObject({ state: "OUTCOME_UNKNOWN" });
		expect(m.start).not.toHaveBeenCalled();
	});
});
describe("server-owned fresh evidence cancellation", () => {
	it("forwards the host abort signal through canonical fresh provider reads", async () => {
		const signal = new AbortController().signal;
		await getDeliverySourceEvidence(
			actor,
			{
				projectId: scope.projectId,
				watchId: watch.id,
				observationId: observation.id,
			},
			signal,
		);
		expect(m.exact).toHaveBeenCalledWith(
			expect.objectContaining({ messageTs: message.externalItemId }),
			{ signal },
		);
	});
	it("does not dispatch any provider read after the host has cancelled", async () => {
		const abort = new AbortController();
		abort.abort();
		await expect(
			getDeliverySourceEvidence(
				actor,
				{
					projectId: scope.projectId,
					watchId: watch.id,
					observationId: observation.id,
				},
				abort.signal,
			),
		).rejects.toThrow();
		expect(m.exact).not.toHaveBeenCalled();
	});
});
describe("expired native history recovery", () => {
	const old = { ...receipt, createdAt: new Date(now.getTime() - 600_001) };
	const stopped = { ...receipt, operation: "CANCEL" };
	it("retains uncertainty and requires an explicit stop fence when old history is missing", async () => {
		m.last.mockResolvedValue(old);
		const result = await getDeliverySourceCaptureStatus(actor, {
			projectId: scope.projectId,
			watchId: watch.id,
		});
		expect(result).toMatchObject({ state: "OUTCOME_UNKNOWN", requestId });
		expect(result.canStartNewCapture).not.toBe(true);
		expect(result.message).toContain("Cancel this request");
		expect(m.start).not.toHaveBeenCalled();
		expect(m.cancelIntent).not.toHaveBeenCalled();
	});
	it("allows fresh admission after explicit fencing and confirmed missing old execution without deleting evidence", async () => {
		m.last.mockResolvedValue(old);
		m.cancellation.mockImplementation(async (_scope, input) =>
			input.workflowId === nativeId ? stopped : null,
		);
		const next = {
			...capture,
			requestId: "55555555-5555-4555-8555-555555555555",
		};
		const nextId = `delivery-source-${hash("NATIVE_CAPTURE", [scope.organizationId, scope.projectId, scope.userId, watch.id, next.requestId, routingDigest])}`;
		const nextReceipt = {
			...receipt,
			requestId: next.requestId,
			payloadHash: hash("CAPTURE", next),
			workflowId: nextId,
		};
		m.admit.mockImplementation(async () => {
			m.pinned.mockResolvedValue({
				...pinned,
				context: {
					...pinned.context,
					watch: {
						...watch,
						lastRequestId: next.requestId,
						lastWorkflowId: nextId,
					},
				},
			});
			return { receipt: nextReceipt, watch, grant, mayDispatch: true };
		});
		expect(
			await getDeliverySourceCaptureStatus(actor, {
				projectId: scope.projectId,
				watchId: watch.id,
			}),
		).toMatchObject({ state: "OUTCOME_UNKNOWN", canStartNewCapture: true });
		const result = await startDeliverySourceCapture(actor, next);
		expect(result.requestId).toBe(next.requestId);
		expect(m.admit).toHaveBeenCalledWith(
			scope,
			expect.objectContaining({
				expectedLastRequestId: requestId,
				requestId: next.requestId,
				workflowId: nextId,
			}),
		);
		expect(m.start).toHaveBeenCalledOnce();
		expect(m.start).toHaveBeenCalledWith(
			"deliverySourceCaptureWorkflow",
			expect.objectContaining({
				workflowId: nextId,
				workflowIdReusePolicy: "REJECT_DUPLICATE",
			}),
		);
		expect(m.configure).not.toHaveBeenCalled();
		expect(m.state).not.toHaveBeenCalled();
	});
	it("never redispatches the old fenced identity on a same-request retry", async () => {
		m.command.mockResolvedValue(old);
		m.cancellation.mockResolvedValue(stopped);
		expect(await startDeliverySourceCapture(actor, capture)).toMatchObject({
			state: "OUTCOME_UNKNOWN",
			requestId,
			canStartNewCapture: true,
		});
		expect(m.start).not.toHaveBeenCalled();
		expect(m.admit).not.toHaveBeenCalled();
	});
	it.each([
		"within-admission",
		"unknown-rpc",
		"unqualified-retention",
		"no-cancellation",
	])("does not offer new capture for %s", async (condition) => {
		m.last.mockResolvedValue(
			condition === "within-admission" ? receipt : old,
		);
		m.cancellation.mockResolvedValue(
			condition === "no-cancellation" ? null : stopped,
		);
		if (condition === "unknown-rpc") {
			m.describe.mockRejectedValue(Error("private RPC unavailable"));
		}
		if (condition === "unqualified-retention") {
			m.namespace.mockResolvedValue({
				namespaceInfo: { name: "example-namespace", id: namespaceId },
				config: {
					workflowExecutionRetentionTtl: { seconds: 300, nanos: 0 },
				},
			});
		}
		const result = await getDeliverySourceCaptureStatus(actor, {
			projectId: scope.projectId,
			watchId: watch.id,
		});
		expect(result.state).toBe("OUTCOME_UNKNOWN");
		expect(result.canStartNewCapture).not.toBe(true);
		await expect(
			startDeliverySourceCapture(actor, {
				...capture,
				requestId: "55555555-5555-4555-8555-555555555555",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.start).not.toHaveBeenCalled();
		expect(m.admit).not.toHaveBeenCalled();
	});
	it("preserves verified native terminal proof when a completed result cannot be read", async () => {
		m.last.mockResolvedValue(receipt);
		m.describe.mockResolvedValue({
			...description,
			status: { name: "COMPLETED" },
		});
		m.result.mockRejectedValue(Error("private result unavailable"));
		expect(
			await getDeliverySourceCaptureStatus(actor, {
				projectId: scope.projectId,
				watchId: watch.id,
			}),
		).toMatchObject({
			state: "OUTCOME_UNKNOWN",
			canStartNewCapture: true,
			captured: null,
		});
		expect(m.start).not.toHaveBeenCalled();
	});
	it("reports safe recovery immediately after explicit cancel persists the old execution fence", async () => {
		m.last.mockResolvedValue(old);
		m.captureByWorkflow.mockResolvedValue(old);
		m.cancelIntent.mockImplementation(async () => {
			m.cancellation.mockResolvedValue(stopped);
			return { receipt: stopped, watch, mayDispatch: true };
		});
		expect(
			await cancelDeliverySourceCapture(actor, {
				projectId: scope.projectId,
				watchId: watch.id,
				requestId: "66666666-6666-4666-8666-666666666666",
			}),
		).toMatchObject({ state: "OUTCOME_UNKNOWN", canStartNewCapture: true });
		expect(m.cancelIntent).toHaveBeenCalledOnce();
		expect(m.cancel).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});
});
describe("idempotent private mutations", () => {
	it("checks an existing request before changed version/network work and never resurrects disconnected watches", async () => {
		const input = {
			projectId: scope.projectId,
			watchId: watch.id,
			requestId,
			expectedVersion: 1,
			action: "PAUSE",
		};
		m.command.mockResolvedValue({
			...receipt,
			operation: "PAUSE",
			payloadHash: hash("PAUSE", input),
		});
		m.watch.mockResolvedValue({
			...watch,
			state: "DISCONNECTED",
			version: 8,
		});
		expect(await updateDeliverySourceState(actor, input)).toMatchObject({
			state: "DISCONNECTED",
			version: 8,
		});
		expect(m.state).not.toHaveBeenCalled();
		expect(m.qualify).not.toHaveBeenCalled();
	});
	it("rejects different payloads reusing the same command ID", async () => {
		m.command.mockResolvedValue({
			...receipt,
			operation: "CONFIGURE",
			payloadHash: "a".repeat(64),
		});
		await expect(
			configureDeliverySource(actor, {
				projectId: scope.projectId,
				integrationId: "example-integration",
				channelId: "C123",
				requestId,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "IDEMPOTENCY_CONFLICT" },
		});
		expect(m.inspect).not.toHaveBeenCalled();
	});
});

describe("cancel and admission fences", () => {
	it("retries cancellation against the admitted old capture, never a subsequently selected capture", async () => {
		const input = {
			projectId: scope.projectId,
			watchId: watch.id,
			requestId: "33333333-3333-4333-8333-333333333333",
		};
		m.command.mockResolvedValue({
			...receipt,
			requestId: input.requestId,
			operation: "CANCEL",
			payloadHash: hash("CANCEL", input),
		});
		m.watch.mockResolvedValue({
			...watch,
			lastWorkflowId: "newer-unrelated-capture",
		});
		m.captureByWorkflow.mockResolvedValue(receipt);
		m.describe.mockResolvedValue(description);
		const handles = vi.spyOn(client.workflow, "getHandle");
		try {
			const result = await cancelDeliverySourceCapture(actor, input);
			expect(result.state).toBe("RUNNING");
			expect(result.message).toContain("Cancellation requested");
			expect(m.captureByWorkflow).toHaveBeenCalledWith(scope, {
				watchId: watch.id,
				workflowId: nativeId,
			});
			expect(handles).toHaveBeenCalledWith(nativeId, description.runId);
			expect(m.cancel).toHaveBeenCalledOnce();
			expect(m.cancelIntent).not.toHaveBeenCalled();
			expect(m.start).not.toHaveBeenCalled();
		} finally {
			handles.mockRestore();
		}
	});
	it("returns unknown rather than a false cancelled state on an ambiguous native cancellation", async () => {
		const input = {
			projectId: scope.projectId,
			watchId: watch.id,
			requestId: "33333333-3333-4333-8333-333333333333",
		};
		m.command.mockResolvedValue({
			...receipt,
			requestId: input.requestId,
			operation: "CANCEL",
			payloadHash: hash("CANCEL", input),
		});
		m.captureByWorkflow.mockResolvedValue(receipt);
		m.describe.mockResolvedValue(description);
		m.cancel.mockRejectedValue(Error("native acknowledgement lost"));
		expect(await cancelDeliverySourceCapture(actor, input)).toMatchObject({
			state: "OUTCOME_UNKNOWN",
			requestId,
		});
	});
	it("labels bounded completed capture with remaining pages as partial and points to CONTINUE", async () => {
		m.last.mockResolvedValue(receipt);
		m.describe.mockResolvedValue({
			...description,
			status: { name: "COMPLETED" },
		});
		m.result.mockResolvedValue({
			captured: 250,
			hasMore: true,
			coverage: "ROOT_MESSAGES_ONLY",
		});
		expect(
			await getDeliverySourceCaptureStatus(actor, {
				projectId: scope.projectId,
				watchId: watch.id,
			}),
		).toMatchObject({
			state: "COMPLETED",
			coverage: "PARTIAL",
			hasMore: true,
			message: expect.stringContaining("CONTINUE"),
		});
	});
	it("requires the current pinned version before any same-id retry dispatch", async () => {
		m.command.mockResolvedValue(receipt);
		m.pinned.mockResolvedValue({
			...pinned,
			context: { ...pinned.context, watch: { ...watch, version: 4 } },
		});
		await expect(
			startDeliverySourceCapture(actor, capture),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.start).not.toHaveBeenCalled();
	});
	it("keeps a previously admitted request unknown if namespace retention cannot be verified", async () => {
		m.command.mockResolvedValue(receipt);
		m.namespace.mockRejectedValue(Error("namespace unavailable"));
		expect(await startDeliverySourceCapture(actor, capture)).toMatchObject({
			state: "OUTCOME_UNKNOWN",
			requestId,
		});
		expect(m.start).not.toHaveBeenCalled();
	});
	it("does not read ciphertext when the credential pair changes during fresh evidence validation", async () => {
		m.pinned.mockResolvedValueOnce(pinned).mockResolvedValueOnce({
			...pinned,
			context: {
				...pinned.context,
				integration: {
					...pinned.context.integration,
					credentials: "encrypted:changed-credential",
				},
			},
		});
		await expect(
			getDeliverySourceEvidence(actor, {
				projectId: scope.projectId,
				watchId: watch.id,
				observationId: observation.id,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.decrypt).not.toHaveBeenCalled();
	});
});

describe("normalized source revisions", () => {
	it("compares normalized stored revisions while retaining exact source snapshot bytes", async () => {
		const edited = {
			...message,
			revision: { kind: "DECIMAL", value: "1762000000.120000" },
		};
		const encoded = JSON.stringify({
			version: 1,
			provider: "SLACK",
			externalItemId: edited.externalItemId,
			revision: { ...edited.revision, value: "1762000000.12" },
			text: edited.text,
			hasReplies: edited.hasReplies,
		});
		m.observation.mockResolvedValue({
			...observation,
			revisionValue: "1762000000.12",
			evidenceDigest: createHash("sha256").update(encoded).digest("hex"),
		});
		m.exact.mockResolvedValue({
			observedAt: now.toISOString(),
			proof: {
				teamId: "T123",
				channelId: "C123",
				humanUserId: "U456",
				botId: "B123",
				botUserId: grant.botUserId,
			},
			message: edited,
		});
		m.decrypt.mockReturnValue(encoded);
		expect(
			await getDeliverySourceEvidence(actor, {
				projectId: scope.projectId,
				watchId: watch.id,
				observationId: observation.id,
			}),
		).toMatchObject({ text: message.text });
	});
});

describe("durable namespace and owner bindings", () => {
	it("refuses a configured namespace switch instead of dispatching the same admission elsewhere", async () => {
		m.command.mockResolvedValue(receipt);
		client.workflow.options.namespace = "another-namespace";
		m.namespace.mockResolvedValue({
			namespaceInfo: {
				name: "another-namespace",
				id: "55555555-5555-4555-8555-555555555555",
			},
			config: {
				workflowExecutionRetentionTtl: { seconds: 3600, nanos: 0 },
			},
		});
		try {
			await expect(
				startDeliverySourceCapture(actor, capture),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(m.start).not.toHaveBeenCalled();
			expect(m.describe).not.toHaveBeenCalled();
		} finally {
			client.workflow.options.namespace = "example-namespace";
		}
	});
	it("requires current watch ownership on same-request native reattachment", async () => {
		m.command.mockResolvedValue(receipt);
		m.watch.mockResolvedValue(null);
		await expect(
			startDeliverySourceCapture(actor, capture),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.client).not.toHaveBeenCalled();
	});
	it("keeps the exact request unknown when native client acquisition fails after admission", async () => {
		m.command.mockResolvedValue(receipt);
		m.client.mockRejectedValue(Error("native client unavailable"));
		expect(await startDeliverySourceCapture(actor, capture)).toMatchObject({
			state: "OUTCOME_UNKNOWN",
			requestId,
		});
		expect(m.admit).not.toHaveBeenCalled();
	});
});

describe("native cluster routing fence", () => {
	it("refuses a recreated same-name namespace with a different namespace UUID", async () => {
		m.command.mockResolvedValue(receipt);
		m.namespace.mockResolvedValue({
			namespaceInfo: {
				name: "example-namespace",
				id: "55555555-5555-4555-8555-555555555555",
			},
			config: {
				workflowExecutionRetentionTtl: { seconds: 3600, nanos: 0 },
			},
		});
		await expect(
			startDeliverySourceCapture(actor, capture),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.start).not.toHaveBeenCalled();
		expect(m.describe).not.toHaveBeenCalled();
	});
	it("refuses a different endpoint even if namespace name and namespace UUID are cloned", async () => {
		m.command.mockResolvedValue(receipt);
		client.workflow.connection.options.address = "another.example.com:7233";
		try {
			await expect(
				startDeliverySourceCapture(actor, capture),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(m.start).not.toHaveBeenCalled();
		} finally {
			client.workflow.connection.options.address =
				"temporal.example.com:7233";
		}
	});
	it("does not qualify new admission without the namespace UUID", async () => {
		m.namespace.mockResolvedValue({
			namespaceInfo: { name: "example-namespace" },
			config: {
				workflowExecutionRetentionTtl: { seconds: 3600, nanos: 0 },
			},
		});
		await expect(
			startDeliverySourceCapture(actor, capture),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(m.admit).not.toHaveBeenCalled();
	});
});

describe("cancel before late native admission", () => {
	it("records cancellation while native missing and prevents a later same-request fresh start", async () => {
		const cancelInput = {
			projectId: scope.projectId,
			watchId: watch.id,
			requestId: "33333333-3333-4333-8333-333333333333",
		};
		const intent = {
			...receipt,
			requestId: cancelInput.requestId,
			operation: "CANCEL",
			payloadHash: hash("CANCEL", cancelInput),
		};
		m.last.mockResolvedValue(receipt);
		m.captureByWorkflow.mockResolvedValue(receipt);
		m.cancelIntent.mockImplementation(async () => {
			m.cancellation.mockResolvedValue(intent);
			return { receipt: intent, watch, mayDispatch: true };
		});
		const cancellation = await cancelDeliverySourceCapture(
			actor,
			cancelInput,
		);
		expect(cancellation.state).toBe("OUTCOME_UNKNOWN");
		expect(cancellation.message).toContain("Cancellation is recorded");
		expect(m.cancel).not.toHaveBeenCalled();
		m.command.mockResolvedValue(receipt);
		const replay = await startDeliverySourceCapture(actor, capture);
		expect(replay.state).toBe("OUTCOME_UNKNOWN");
		expect(m.start).not.toHaveBeenCalled();
		expect(m.qualify).not.toHaveBeenCalled();
		// A delayed original start may still become nativeRUNNING; report that truth without reviving capture.
		m.describe.mockResolvedValue(description);
		expect(await startDeliverySourceCapture(actor, capture)).toMatchObject({
			state: "RUNNING",
			message: expect.stringContaining("Cancellation is recorded"),
		});
		expect(m.start).not.toHaveBeenCalled();
	});
	it("rechecks durable cancellation immediately before start after source proof", async () => {
		m.command.mockResolvedValue(receipt);
		m.qualify.mockImplementation(async () => {
			m.cancellation.mockResolvedValue({
				...receipt,
				operation: "CANCEL",
			});
			return {
				teamId: "T123",
				channelId: "C123",
				humanUserId: "U456",
				botId: "B123",
				botUserId: "U123",
			};
		});
		const result = await startDeliverySourceCapture(actor, capture);
		expect(result.state).toBe("OUTCOME_UNKNOWN");
		expect(result.message).toContain("Cancellation is recorded");
		expect(m.start).not.toHaveBeenCalled();
	});
	it("reports CANCELLED only when the native execution confirms cancellation", async () => {
		m.command.mockResolvedValue(receipt);
		m.cancellation.mockResolvedValue({ ...receipt, operation: "CANCEL" });
		m.describe.mockResolvedValue({
			...description,
			status: { name: "CANCELLED" },
		});
		expect(await startDeliverySourceCapture(actor, capture)).toMatchObject({
			state: "CANCELLED",
		});
		expect(m.start).not.toHaveBeenCalled();
	});
});

import { PrivateDeliverySourceUnavailableError } from "@repo/temporal/delivery-source-readiness";

describe("operator and storage availability", () => {
	it.each(["NOT_ENABLED", "STORAGE_UNAVAILABLE"] as const)(
		"returns explicit %s only after authorization without source-table reads",
		async (reason) => {
			m.availability.mockResolvedValue({ state: "UNAVAILABLE", reason });
			expect(
				await listDeliverySourceWatches(actor, {
					projectId: scope.projectId,
				}),
			).toEqual({
				version: 1,
				availability: { state: "UNAVAILABLE", reason },
				watches: [],
				connections: [],
			});
			expect(m.project).toHaveBeenCalled();
			expect(m.member).toHaveBeenCalled();
			expect(m.watches).not.toHaveBeenCalled();
			expect(m.integrations).not.toHaveBeenCalled();
		},
	);
	it("preserves current actor refusal before checking feature availability", async () => {
		m.member.mockResolvedValue(null);
		m.availability.mockResolvedValue({
			state: "UNAVAILABLE",
			reason: "NOT_ENABLED",
		});
		await expect(
			listDeliverySourceWatches(actor, { projectId: scope.projectId }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.availability).not.toHaveBeenCalled();
	});
	it("refuses capture/status/evidence with coded503 before any source-table or native/provider access", async () => {
		m.ready.mockRejectedValue(
			new PrivateDeliverySourceUnavailableError("NOT_ENABLED"),
		);
		for (const work of [
			() =>
				getDeliverySourceCaptureStatus(actor, {
					projectId: scope.projectId,
					watchId: watch.id,
				}),
			() => startDeliverySourceCapture(actor, capture),
			() =>
				getDeliverySourceEvidence(actor, {
					projectId: scope.projectId,
					watchId: watch.id,
					observationId: observation.id,
				}),
		]) {
			await expect(work()).rejects.toMatchObject({
				code: "SERVICE_UNAVAILABLE",
				data: { code: "PRIVATE_SOURCE_CAPTURE_UNAVAILABLE" },
			});
		}
		expect(m.watch).not.toHaveBeenCalled();
		expect(m.command).not.toHaveBeenCalled();
		expect(m.observation).not.toHaveBeenCalled();
		expect(m.client).not.toHaveBeenCalled();
		expect(m.exact).not.toHaveBeenCalled();
	});
});

describe("bounded encrypted evidence size", () => {
	it("accepts valid16KiB source text even when JSON escaping makes the ciphertext exceed100KB", async () => {
		const text = "\u0000".repeat(16_384);
		const large = { ...message, text };
		const encoded = JSON.stringify({
			version: 1,
			provider: "SLACK",
			externalItemId: large.externalItemId,
			revision: large.revision,
			text,
			hasReplies: large.hasReplies,
		});
		expect(Buffer.byteLength(text, "utf8")).toBe(16_384);
		expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(128 * 1024);
		const ciphertext = `encrypted:${Buffer.from(encoded).toString("base64")}`;
		expect(ciphertext.length).toBeGreaterThan(100_000);
		expect(ciphertext.length).toBeLessThan(262_144);
		m.observation.mockResolvedValue({
			...observation,
			ciphertext,
			evidenceDigest: createHash("sha256").update(encoded).digest("hex"),
		});
		m.decrypt.mockReturnValue(encoded);
		m.exact.mockResolvedValue({
			observedAt: now.toISOString(),
			proof: {
				teamId: "T123",
				channelId: "C123",
				humanUserId: "U456",
				botId: "B123",
				botUserId: grant.botUserId,
			},
			message: large,
		});
		expect(
			await getDeliverySourceEvidence(actor, {
				projectId: scope.projectId,
				watchId: watch.id,
				observationId: observation.id,
			}),
		).toMatchObject({ text });
	});
	it("rejects decrypted plaintext above128KiB in UTF8 before returning evidence", async () => {
		m.decrypt.mockReturnValue("😀".repeat(40_000));
		await expect(
			getDeliverySourceEvidence(actor, {
				projectId: scope.projectId,
				watchId: watch.id,
				observationId: observation.id,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});

it("does not weaken the16KiB source-body UTF8 bound for multibyte text", async () => {
	const text = "😀".repeat(5_000);
	expect(text.length).toBeLessThan(16_384);
	expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(16_384);
	m.exact.mockResolvedValue({
		observedAt: now.toISOString(),
		proof: {
			teamId: "T123",
			channelId: "C123",
			humanUserId: "U456",
			botId: "B123",
			botUserId: grant.botUserId,
		},
		message: { ...message, text },
	});
	await expect(
		getDeliverySourceEvidence(actor, {
			projectId: scope.projectId,
			watchId: watch.id,
			observationId: observation.id,
		}),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(m.decrypt).not.toHaveBeenCalled();
});

describe("private triage evidence live authority gate", () => {
	it("delegates the current bound project authorization before any network permission", async () => {
		m.project.mockRejectedValue(new ORPCError("NOT_FOUND"));
		await expect(
			requirePrivateDeliverySourceEvidenceAccess(actor, scope.projectId),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.member).not.toHaveBeenCalled();
	});
	it("refuses a user with no current organization membership", async () => {
		m.member.mockResolvedValue(null);
		await expect(
			requirePrivateDeliverySourceEvidenceAccess(actor, scope.projectId),
		).rejects.toMatchObject({ data: { code: "INSUFFICIENT_PERMISSION" } });
	});
	it("refuses a role without integration permissions", async () => {
		m.member.mockResolvedValue({ role: "viewer" });
		await expect(
			requirePrivateDeliverySourceEvidenceAccess(actor, scope.projectId),
		).rejects.toMatchObject({ data: { code: "INSUFFICIENT_PERMISSION" } });
	});
	it("checks the deployment gate even for a current owner", async () => {
		m.ready.mockRejectedValue(Error("Example unavailable"));
		await expect(
			requirePrivateDeliverySourceEvidenceAccess(actor, scope.projectId),
		).rejects.toThrow();
	});
});

describe("explicit bounded history capture", () => {
	const window = {
		start: "2026-10-05T00:00:00.000Z",
		end: "2026-10-07T00:00:00.000Z",
	};
	it.each([
		{ mode: "BACKFILL" },
		{ mode: "RECENT", window },
		{ mode: "CONTINUE", window },
		{ mode: "BACKFILL", window: { start: window.end, end: window.start } },
		{
			mode: "BACKFILL",
			window: { start: "2026-09-01T00:00:00.000Z", end: window.end },
		},
		{
			mode: "BACKFILL",
			window: {
				start: "2026-11-08T00:00:00.000Z",
				end: "2026-11-09T00:00:00.000Z",
			},
		},
		{
			mode: "BACKFILL",
			window: {
				start: "2026-01-01T00:00:00.000Z",
				end: "2026-01-02T00:00:00.000Z",
			},
		},
	])(
		"refuses malformed, unbounded or future history intent before admission %j",
		async (extra) => {
			m.command.mockResolvedValue(null);
			await expect(
				startDeliverySourceCapture(actor, { ...capture, ...extra }),
			).rejects.toBeDefined();
			expect(m.admit).not.toHaveBeenCalled();
			expect(m.start).not.toHaveBeenCalled();
		},
	);
	it("persists the explicit window in the canonical admission", async () => {
		m.command.mockResolvedValue(null);
		m.last.mockResolvedValue(null);
		m.admit.mockRejectedValue(
			new Error("Example stop after admission inspection"),
		);
		await expect(
			startDeliverySourceCapture(actor, {
				...capture,
				mode: "BACKFILL",
				window,
			}),
		).rejects.toBeDefined();
		expect(m.admit).toHaveBeenCalledWith(
			scope,
			expect.objectContaining({ mode: "BACKFILL", window }),
		);
	});
});

it("normalizes equivalent history timestamp spellings before request hashing",async()=>{
 const {deliverySourceCaptureInput}=await import("../delivery-source-contracts");
 const first=deliverySourceCaptureInput.parse({...capture,mode:"BACKFILL",window:{start:"2026-10-05T00:00:00Z",end:"2026-10-07T00:00:00Z"}});
 const recovered=deliverySourceCaptureInput.parse({...capture,mode:"BACKFILL",window:{start:"2026-10-05T00:00:00.000Z",end:"2026-10-07T00:00:00.000Z"}});
 expect(hash("CAPTURE",first)).toBe(hash("CAPTURE",recovered));
 expect(first.window).toEqual(recovered.window);
});
