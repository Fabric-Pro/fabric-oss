import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	access: vi.fn(),
	evidence: vi.fn(),
	observation: vi.fn(),
	watch: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getOwnedDeliverySourceObservation: m.observation,
	getOwnedDeliverySourceWatch: m.watch,
}));
vi.mock("../delivery-source-commands", () => ({
	requirePrivateDeliverySourceEvidenceAccess: m.access,
	getDeliverySourceEvidence: m.evidence,
}));

import { createPrivateTriageEvidenceReader } from "../harness-triage-evidence";

const scope = {
	organizationId: "example-org",
	userId: "example-user",
	projectId: "example-project",
};
const pin = {
	observationId: "example-observation",
	watchId: "example-watch",
	grantId: "example-grant",
	grantRevision: 1,
	evidenceDigest: "a".repeat(64),
};
const authority = {
	runId: "example-run",
	organizationId: scope.organizationId,
	actorId: scope.userId,
	projectId: scope.projectId,
	inputHash: "b".repeat(64),
	evidence: [pin],
	model: { id: "example-model", maxOutputTokens: 128 },
};
const actor = {
	userId: scope.userId,
	organizationBinding: { organizationId: scope.organizationId },
};
beforeEach(() => {
	vi.resetAllMocks();
	m.access.mockResolvedValue(scope);
	m.evidence.mockResolvedValue({ text: "Example current source text" });
	m.observation.mockResolvedValue({
		...pin,
		grantId: pin.grantId,
		hasConflict: false,
		expiresAt: new Date(Date.now() + 60000),
	});
	m.watch.mockResolvedValue({ grantRevision: 1 });
});
describe("canonical fresh-evidence triage adapter", () => {
	it.each([
		{ scopes: [] },
		{ scopes: ["projects:read", "features:read"] },
		{ scopes: ["projects:read", "integrations:read"] },
	])(
		"refuses insufficient originating key scopes %j before authorization or source work",
		async ({ scopes }) => {
			await expect(
				createPrivateTriageEvidenceReader(actor, scope.projectId, {
					kind: "API_KEY",
					scopes,
				}),
			).rejects.toMatchObject({ data: { code: "INSUFFICIENT_SCOPE" } });
			expect(m.access).not.toHaveBeenCalled();
			expect(m.evidence).not.toHaveBeenCalled();
		},
	);
	it("still checks current permissions for wildcard key credentials", async () => {
		m.access.mockRejectedValue(Error("Example creator permission revoked"));
		await expect(
			createPrivateTriageEvidenceReader(actor, scope.projectId, {
				kind: "API_KEY",
				scopes: ["*"],
			}),
		).rejects.toThrow();
		expect(m.access).toHaveBeenCalledOnce();
		expect(m.evidence).not.toHaveBeenCalled();
	});
	it("accepts read-scoped keys with all required scopes and freshly checks their creator", async () => {
		const read = await createPrivateTriageEvidenceReader(
			actor,
			scope.projectId,
			{
				kind: "API_KEY",
				scopes: ["projects:read", "features:read", "integrations:read"],
			},
		);
		await expect(
			read(authority, pin, new AbortController().signal),
		).resolves.toMatchObject({ pin });
		expect(m.access).toHaveBeenCalledTimes(3);
	});
	it("uses bound actor and canonical source proof, with metadata and permission checks before and after", async () => {
		const read = await createPrivateTriageEvidenceReader(
			actor,
			scope.projectId,
			{ kind: "SESSION" },
		);
		expect(
			await read(authority, pin, new AbortController().signal),
		).toMatchObject({ pin, text: "Example current source text" });
		expect(m.evidence).toHaveBeenCalledWith(
			{ ...actor, boundProjectId: scope.projectId },
			{
				projectId: scope.projectId,
				watchId: pin.watchId,
				observationId: pin.observationId,
			},
			expect.any(AbortSignal),
		);
		expect(m.access).toHaveBeenCalledTimes(3);
		expect(m.observation).toHaveBeenCalledTimes(2);
	});
	it.each(["organizationId", "actorId", "projectId"])(
		"refuses foreign %s before any source disclosure",
		async (key) => {
			const read = await createPrivateTriageEvidenceReader(
				actor,
				scope.projectId,
				{ kind: "SESSION" },
			);
			await expect(
				read(
					{ ...authority, [key]: "example-foreign" },
					pin,
					new AbortController().signal,
				),
			).rejects.toThrow();
			expect(m.evidence).not.toHaveBeenCalled();
			expect(m.observation).not.toHaveBeenCalled();
		},
	);
	it("never substitutes an unselected observation", async () => {
		const read = await createPrivateTriageEvidenceReader(
			actor,
			scope.projectId,
			{ kind: "SESSION" },
		);
		await expect(
			read(
				authority,
				{ ...pin, observationId: "example-other" },
				new AbortController().signal,
			),
		).rejects.toThrow();
		expect(m.evidence).not.toHaveBeenCalled();
	});
	it.each(["digest", "grant", "revision", "conflict", "expiry"])(
		"refuses stale %s metadata before fetching plaintext",
		async (kind) => {
			if (kind === "digest") {
				m.observation.mockResolvedValue({
					...pin,
					grantId: pin.grantId,
					evidenceDigest: "b".repeat(64),
					expiresAt: new Date(Date.now() + 60000),
				});
			}
			if (kind === "grant") {
				m.observation.mockResolvedValue({
					...pin,
					grantId: "example-other",
					expiresAt: new Date(Date.now() + 60000),
				});
			}
			if (kind === "revision") {
				m.watch.mockResolvedValue({ grantRevision: 2 });
			}
			if (kind === "conflict") {
				m.observation.mockResolvedValue({
					...pin,
					grantId: pin.grantId,
					hasConflict: true,
					expiresAt: new Date(Date.now() + 60000),
				});
			}
			if (kind === "expiry") {
				m.observation.mockResolvedValue({
					...pin,
					grantId: pin.grantId,
					expiresAt: new Date(Date.now() - 1),
				});
			}
			const read = await createPrivateTriageEvidenceReader(
				actor,
				scope.projectId,
				{ kind: "SESSION" },
			);
			await expect(
				read(authority, pin, new AbortController().signal),
			).rejects.toThrow();
			expect(m.evidence).not.toHaveBeenCalled();
		},
	);
	it("withholds text if access is revoked during provider proof", async () => {
		const read = await createPrivateTriageEvidenceReader(
			actor,
			scope.projectId,
			{ kind: "SESSION" },
		);
		m.evidence.mockImplementation(async () => {
			m.access.mockRejectedValue(
				Error("Example current permission refused"),
			);
			return { text: "Example private text" };
		});
		await expect(
			read(authority, pin, new AbortController().signal),
		).rejects.toThrow();
	});
	it("withholds text when the grant rotates during the canonical fresh read", async () => {
		const read = await createPrivateTriageEvidenceReader(
			actor,
			scope.projectId,
			{ kind: "SESSION" },
		);
		m.evidence.mockImplementation(async () => {
			m.watch.mockResolvedValue({ grantRevision: 2 });
			return { text: "Example private text" };
		});
		await expect(
			read(authority, pin, new AbortController().signal),
		).rejects.toThrow();
	});
	it("stops a cancelled read before source work", async () => {
		const read = await createPrivateTriageEvidenceReader(
			actor,
			scope.projectId,
			{ kind: "SESSION" },
		);
		const abort = new AbortController();
		abort.abort();
		await expect(read(authority, pin, abort.signal)).rejects.toThrow();
		expect(m.evidence).not.toHaveBeenCalled();
	});
});
