import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	scope: vi.fn(),
	source: vi.fn(),
	edit: vi.fn(),
	member: vi.fn(),
	key: vi.fn(),
	run: vi.fn(),
	list: vi.fn(),
	request: vi.fn(),
	observation: vi.fn(),
	watch: vi.fn(),
	cancel: vi.fn(),
	start: vi.fn(),
	mark: vi.fn(),
	reader: vi.fn(),
	read: vi.fn(),
	decrypt: vi.fn(),
	consent: vi.fn(),
	access: vi.fn(),
	refresh: vi.fn(),
	uncertain: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		member: { findUnique: m.member },
		organizationApiKey: { findFirst: m.key },
		userApiKey: { findFirst: m.key },
		oauthClient: { findFirst: m.key },
		oauthConsent: { findFirst: m.consent },
		oauthAccessToken: { findFirst: m.access },
		oauthRefreshToken: { findFirst: m.refresh },
	},
	canEditProject: m.edit,
	getHarnessTriageRun: m.run,
	countUncertainHarnessTriageCalls: m.uncertain,
	findHarnessTriageObservation: m.observation,
	listHarnessTriageRuns: m.list,
	findHarnessTriageRequest: m.request,
	admitHarnessTriageRun: vi.fn(),
	cancelHarnessTriageRun: m.cancel,
	markHarnessTriageNativeRun: m.mark,
	reviewHarnessTriageProposal: vi.fn(),
	getOwnedDeliverySourceObservation: m.observation,
	getOwnedDeliverySourceWatch: m.watch,
}));
vi.mock("../delivery-signals", () => ({
	requireDeliverySignalProjectAccess: m.scope,
	deliverySignalPermissionDenied: () => {
		throw new ORPCError("FORBIDDEN", {
			data: { code: "INSUFFICIENT_PERMISSION" },
		});
	},
}));
vi.mock("../delivery-source-commands", () => ({
	requirePrivateDeliverySourceEvidenceAccess: m.source,
	requirePrivateDeliverySourceProject: m.source,
}));
vi.mock("../harness-triage-evidence", () => ({
	createPrivateTriageEvidenceReader: m.reader,
}));
vi.mock("../harness-triage-native", () => ({
	resolveTriageExecutionBinding: vi.fn(async () => ({
		namespace: "example",
		namespaceId: "example-namespace-id",
		routingDigest: "a".repeat(64),
	})),
	triageStoredModel: {
		parse: () => ({ execution: { routingDigest: "a".repeat(64) } }),
	},
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: m.decrypt,
	encryptApiKey: (x: string) => `encrypted:${x}`,
}));
vi.mock("@repo/temporal/client", () => ({
	getTemporalClient: async () => ({ workflow: { start: m.start } }),
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(x: T) => x,
}));

import {
	checkTriageCredential,
	privateTriageCommands,
	requireTriageScopes,
} from "../harness-triage-commands";

const scope = {
	organizationId: "example-org",
	projectId: "example-project",
	userId: "example-user",
};
const actor = {
	userId: scope.userId,
	credential: { kind: "SESSION" as const },
};
const pin = {
	observationId: "example-observation",
	watchId: "example-watch",
	grantId: "example-grant",
	grantRevision: 1,
	evidenceDigest: "a".repeat(64),
};
const input = {
	projectId: scope.projectId,
	requestId: "11111111-1111-4111-8111-111111111111",
	goal: "Find supported delivery risks",
	evidenceIds: [pin.observationId],
};
const row = {
	...scope,
	id: "example-run",
	requestId: input.requestId,
	inputHash: createHash("sha256")
		.update(JSON.stringify([1, input.goal, input.evidenceIds]))
		.digest("hex"),
	evidence: [pin],
	credential: { kind: "SESSION" },
	createdAt: new Date(),
	expiresAt: new Date(Date.now() + 60000),
	status: "QUEUED",
	failureCode: null,
	model: {},
	workflowId: "example-native-workflow",
	nativeRunId: null,
	cancelRequestedAt: null,
	resultCiphertext: null,
	reviews: {},
};
beforeEach(() => {
	vi.resetAllMocks();
	delete process.env.FABRIC_HARNESS_TRIAGE_ENABLED;
	delete process.env.FABRIC_HARNESS_TRIAGE_MONTHLY_MICRO_USD;
	m.scope.mockResolvedValue(scope);
	m.source.mockResolvedValue(scope);
	m.edit.mockResolvedValue(true);
	m.member.mockResolvedValue({ role: "owner" });
	m.key.mockResolvedValue({ scopes: ["*"] });
	m.run.mockResolvedValue({ ...row });
	m.uncertain.mockResolvedValue(0);
	m.list.mockResolvedValue([{ ...row }]);
	m.request.mockResolvedValue(null);
	m.reader.mockResolvedValue(m.read);
	m.observation.mockResolvedValue({
		...pin,
		hasConflict: false,
		expiresAt: new Date(Date.now() + 60000),
	});
	m.watch.mockResolvedValue({ grantRevision: 1 });
});
describe("private Harness triage canonical security", () => {
	it("lists only minimized owner metadata when starts are disabled", async () => {
		const out = await privateTriageCommands.list(actor, {
			projectId: scope.projectId,
		});
		expect(out.availability).toBe("NOT_ENABLED");
		expect(out.runs[0]).not.toHaveProperty("evidence");
		expect(out.runs[0]).not.toHaveProperty("credential");
		expect(out.runs[0]).not.toHaveProperty("goalCiphertext");
		expect(m.list).toHaveBeenCalledWith(scope, undefined);
	});
	it("does not turn missing scope into a current-permission check", async () => {
		await expect(
			privateTriageCommands.start(
				{
					...actor,
					credential: {
						kind: "ORGANIZATION_API_KEY",
						id: "example-key",
						scopes: ["projects:read"],
					},
				},
				input,
			),
		).rejects.toMatchObject({ data: { code: "INSUFFICIENT_SCOPE" } });
		expect(m.scope).not.toHaveBeenCalled();
	});
	it("checks current object rights unconditionally for wildcard keys", async () => {
		m.edit.mockResolvedValue(false);
		await expect(
			privateTriageCommands.start(
				{
					...actor,
					credential: {
						kind: "ORGANIZATION_API_KEY",
						id: "example-key",
						scopes: ["*"],
					},
				},
				input,
			),
		).rejects.toMatchObject({ data: { code: "INSUFFICIENT_PERMISSION" } });
		expect(m.key).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					organizationId: scope.organizationId,
					createdByUserId: scope.userId,
					isActive: true,
				}),
			}),
		);
		expect(m.request).not.toHaveBeenCalled();
	});
	it("never widens an original admission's revoked key for a later browser reader", async () => {
		m.run.mockResolvedValue({
			...row,
			status: "COMPLETED",
			resultCiphertext: "encrypted:private",
			credential: {
				kind: "ORGANIZATION_API_KEY",
				id: "example-original-key",
				scopes: ["*"],
			},
		});
		m.key.mockResolvedValue(null);
		await expect(
			privateTriageCommands.result(actor, {
				projectId: scope.projectId,
				runId: row.id,
			}),
		).rejects.toMatchObject({ data: { code: "INSUFFICIENT_PERMISSION" } });
		expect(m.reader).not.toHaveBeenCalled();
		expect(m.decrypt).not.toHaveBeenCalled();
	});
	it.each([
		"organizationId",
		"actorId",
		"model",
		"policy",
		"target",
		"budget",
	])(
		"rejects public %s overrides before any authorization or admission",
		async (key) => {
			await expect(
				privateTriageCommands.start(actor, {
					...input,
					[key]: "example-override",
				}),
			).rejects.toThrow();
			expect(m.scope).not.toHaveBeenCalled();
		},
	);
	it("rejects a character-valid but UTF-8 over-size goal before saving a run", async () => {
		await expect(
			privateTriageCommands.start(actor, {
				...input,
				goal: "界".repeat(1000),
			}),
		).rejects.toThrow();
		expect(m.scope).not.toHaveBeenCalled();
	});
	it("performs no admission while operator enable/budget are absent", async () => {
		await expect(
			privateTriageCommands.start(actor, input),
		).rejects.toMatchObject({ data: { code: "TRIAGE_NOT_ENABLED" } });
		expect(m.start).not.toHaveBeenCalled();
		expect(m.request).not.toHaveBeenCalled();
	});
	it("checks the source before decrypting a completed result", async () => {
		m.run.mockResolvedValue({
			...row,
			status: "COMPLETED",
			resultCiphertext: "encrypted:private",
		});
		m.observation.mockResolvedValue(null);
		await expect(
			privateTriageCommands.result(actor, {
				projectId: scope.projectId,
				runId: row.id,
			}),
		).rejects.toMatchObject({ data: { code: "EVIDENCE_UNAVAILABLE" } });
		expect(m.decrypt).not.toHaveBeenCalled();
	});
	it("keeps a lost native start acknowledgement uncertain with the saved request", async () => {
		process.env.FABRIC_HARNESS_TRIAGE_ENABLED = "true";
		process.env.FABRIC_HARNESS_TRIAGE_MONTHLY_MICRO_USD = "1000000";
		m.request.mockResolvedValue({ ...row });
		m.start.mockRejectedValue(Error("Example lost acknowledgement"));
		await expect(
			privateTriageCommands.start(actor, input),
		).rejects.toMatchObject({ data: { code: "OUTCOME_UNKNOWN" } });
		expect(m.start).toHaveBeenCalledWith(
			"harnessSignalTriageWorkflow",
			expect.objectContaining({
				workflowId: row.workflowId,
				workflowIdReusePolicy: "REJECT_DUPLICATE",
			}),
		);
	});
	it("does not charge or restart a different input using the same request ID", async () => {
		process.env.FABRIC_HARNESS_TRIAGE_ENABLED = "true";
		process.env.FABRIC_HARNESS_TRIAGE_MONTHLY_MICRO_USD = "1000000";
		m.request.mockResolvedValue({ ...row });
		await expect(
			privateTriageCommands.start(actor, {
				...input,
				goal: "Different goal",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.start).not.toHaveBeenCalled();
	});
	it("binds continuation to actor and project before querying the store", async () => {
		const before = Buffer.from(
			JSON.stringify({
				version: 1,
				...scope,
				userId: "example-other",
				createdAt: row.createdAt.toISOString(),
				id: row.id,
			}),
		).toString("base64url");
		await expect(
			privateTriageCommands.list(actor, {
				projectId: scope.projectId,
				before,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.list).not.toHaveBeenCalled();
	});
	it("retains an ID tie-breaker when page rows share the same timestamp", async () => {
		m.list.mockResolvedValue(
			Array.from({ length: 21 }, (_, i) => ({
				...row,
				id: `example-run-${i}`,
			})),
		);
		const out = await privateTriageCommands.list(actor, {
			projectId: scope.projectId,
		});
		expect(
			JSON.parse(Buffer.from(out.nextBefore!, "base64url").toString()),
		).toMatchObject({ ...scope, id: "example-run-19" });
	});
	it("requires current network scopes to disclose private results", () => {
		expect(() =>
			requireTriageScopes(
				{
					kind: "USER_API_KEY",
					id: "example-key",
					scopes: [
						"projects:read",
						"features:read",
						"integrations:read",
					],
				},
				"result",
			),
		).toThrow();
	});
});

describe("exact originating OAuth grant", () => {
	const credential = {
		kind: "OAUTH_CLIENT" as const,
		id: "example-client-row",
		scopes: ["*"],
		referenceId: "project:api:example-project",
	};
	it("uses the exact project grant rather than widening to an organization consent", async () => {
		m.key.mockResolvedValue({ clientId: "example-public-client" });
		m.consent.mockResolvedValue({ scopes: ["*"] });
		m.access.mockResolvedValue({ id: "example-access", scopes: ["*"] });
		await checkTriageCredential(scope, credential, "result");
		expect(m.consent).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					clientId: "example-public-client",
					userId: scope.userId,
					referenceId: credential.referenceId,
				},
			}),
		);
		expect(m.access).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					referenceId: credential.referenceId,
					revoked: null,
				}),
			}),
		);
	});
	it("refuses revoked access and refresh tokens even if consent remains", async () => {
		m.key.mockResolvedValue({ clientId: "example-public-client" });
		m.consent.mockResolvedValue({ scopes: ["*"] });
		m.access.mockResolvedValue(null);
		m.refresh.mockResolvedValue(null);
		await expect(
			checkTriageCredential(scope, credential, "result"),
		).rejects.toMatchObject({ data: { code: "INSUFFICIENT_PERMISSION" } });
	});
	it("refuses a grant for a different project before looking up a client", async () => {
		await expect(
			checkTriageCredential(
				scope,
				{
					...credential,
					referenceId: "project:api:example-other-project",
				},
				"result",
			),
		).rejects.toMatchObject({ data: { code: "INSUFFICIENT_PERMISSION" } });
		expect(m.key).not.toHaveBeenCalled();
	});
	it("checks the grant's current scopes even when its original ceiling was wildcard", async () => {
		m.key.mockResolvedValue({ clientId: "example-public-client" });
		m.consent.mockResolvedValue({ scopes: ["projects:read"] });
		m.refresh.mockResolvedValue({ id: "example-refresh", scopes: ["*"] });
		await expect(
			checkTriageCredential(scope, credential, "result"),
		).rejects.toMatchObject({ data: { code: "INSUFFICIENT_SCOPE" } });
	});
});

it("keeps content-free owner status available after original key revocation and discloses held spend", async () => {
	m.run.mockResolvedValue({
		...row,
		status: "CANCELLED",
		failureCode: null,
		credential: {
			kind: "ORGANIZATION_API_KEY",
			id: "example-revoked-key",
			scopes: ["*"],
		},
	});
	m.key.mockResolvedValue(null);
	m.uncertain.mockResolvedValue(1);
	const out = await privateTriageCommands.status(actor, {
		projectId: scope.projectId,
		runId: row.id,
	});
	expect(out).toMatchObject({
		status: "CANCELLED",
		failureCode: "OUTCOME_UNKNOWN",
	});
	expect(m.decrypt).not.toHaveBeenCalled();
});
