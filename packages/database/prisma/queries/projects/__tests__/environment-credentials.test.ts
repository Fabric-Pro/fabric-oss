/**
 * Unit tests for environment sign-in credentials.
 *
 * These are almost entirely about what must NOT happen: a secret must not come
 * back out of a read path, must not survive being switched off, and must not
 * crash a run when it cannot be decrypted. The happy path is one line.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, encryptMock, decryptMock } = vi.hoisted(() => ({
	dbMock: {
		projectEnvironment: {
			findFirst: vi.fn(),
			findMany: vi.fn(),
			updateMany: vi.fn(),
		},
	},
	// Opaque both ways, like real AES output — a mock that embeds the plaintext
	// would make "the secret never appears in the write payload" untestable.
	encryptMock: vi.fn((v: string) =>
		Buffer.from(v, "utf8").toString("base64"),
	),
	decryptMock: vi.fn((v: string) =>
		Buffer.from(v, "base64").toString("utf8"),
	),
}));

vi.mock("../../../client", () => ({ db: dbMock }));
vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => encryptMock(v),
	decryptApiKey: (v: string) => decryptMock(v),
}));

import {
	ENVIRONMENT_PUBLIC_FIELDS,
	ENVIRONMENT_SECRET_FIELDS,
	listEnvironmentAuthSummaries,
	resolveEnvironmentAuth,
	setEnvironmentAuth,
} from "../environment-credentials";

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.projectEnvironment.updateMany.mockResolvedValue({ count: 1 });
});

describe("the public/secret field split", () => {
	it("keeps every secret column out of the browser-safe list", () => {
		// The GENERATED whole-model ProjectEnvironmentSchema includes
		// encryptedAuthSecret, because it mirrors every column. Nothing imports it
		// today, but a procedure reaching for it as an `output` schema is the
		// obvious mistake — this pins the safe shape so the two cannot converge.
		for (const secret of ENVIRONMENT_SECRET_FIELDS) {
			expect(ENVIRONMENT_PUBLIC_FIELDS).not.toContain(secret);
		}
	});
});

describe("setEnvironmentAuth", () => {
	it("never stores the secret in plaintext", async () => {
		await setEnvironmentAuth({
			projectId: "p1",
			environmentId: "e1",
			authKind: "FORM",
			authUsername: "qa@acme.test",
			secret: "hunter2",
		});

		const data = dbMock.projectEnvironment.updateMany.mock.calls[0][0].data;
		expect(encryptMock).toHaveBeenCalledWith("hunter2");
		expect(data.encryptedAuthSecret).toBe(
			Buffer.from("hunter2", "utf8").toString("base64"),
		);
		expect(JSON.stringify(data)).not.toContain("hunter2");
	});

	it("scopes the write by projectId so a foreign environment is untouched", async () => {
		await setEnvironmentAuth({
			projectId: "p1",
			environmentId: "someone-elses",
			authKind: "TOKEN",
			secret: "t",
		});

		expect(
			dbMock.projectEnvironment.updateMany.mock.calls[0][0].where,
		).toEqual({ id: "someone-elses", projectId: "p1" });
	});

	it("wipes the secret when auth is switched off", async () => {
		// "Needs no sign-in" and "still has my password lying about" must not be
		// the same state.
		await setEnvironmentAuth({
			projectId: "p1",
			environmentId: "e1",
			authKind: "NONE",
		});

		const data = dbMock.projectEnvironment.updateMany.mock.calls[0][0].data;
		expect(data.encryptedAuthSecret).toBeNull();
		expect(data.authUsername).toBeNull();
		expect(data.authHeaderName).toBeNull();
		expect(data.authUpdatedAt).toBeNull();
	});

	it("keeps the stored secret when the caller only edits the username", async () => {
		// Otherwise changing an email would silently clear the password.
		await setEnvironmentAuth({
			projectId: "p1",
			environmentId: "e1",
			authKind: "FORM",
			authUsername: "new@acme.test",
		});

		const data = dbMock.projectEnvironment.updateMany.mock.calls[0][0].data;
		expect(data).not.toHaveProperty("encryptedAuthSecret");
		expect(encryptMock).not.toHaveBeenCalled();
	});

	it("treats an empty-string secret as clearing, not as a crash", async () => {
		// encryptApiKey THROWS on empty input, so a form that blanks a password
		// field and submits "" would have produced a 500 out of a database write
		// instead of the obvious outcome.
		await expect(
			setEnvironmentAuth({
				projectId: "p1",
				environmentId: "e1",
				authKind: "FORM",
				secret: "",
			}),
		).resolves.toEqual({ updated: true });

		const data = dbMock.projectEnvironment.updateMany.mock.calls[0][0].data;
		expect(data.encryptedAuthSecret).toBeNull();
		expect(encryptMock).not.toHaveBeenCalled();
	});

	it("clears the secret on an explicit null", async () => {
		await setEnvironmentAuth({
			projectId: "p1",
			environmentId: "e1",
			authKind: "FORM",
			secret: null,
		});

		expect(
			dbMock.projectEnvironment.updateMany.mock.calls[0][0].data
				.encryptedAuthSecret,
		).toBeNull();
	});
});

describe("listEnvironmentAuthSummaries", () => {
	it("reports THAT a secret exists without returning it", async () => {
		dbMock.projectEnvironment.findMany.mockResolvedValue([
			{
				id: "e1",
				authKind: "FORM",
				authUsername: "qa@acme.test",
				authHeaderName: null,
				authUpdatedAt: new Date("2026-07-26T00:00:00Z"),
				encryptedAuthSecret: "aHVudGVyMg==",
			},
		]);

		const [summary] = await listEnvironmentAuthSummaries({
			projectId: "p1",
		});

		expect(summary.hasSecret).toBe(true);
		// Neither the plaintext nor the ciphertext may reach a render path.
		const serialised = JSON.stringify(summary);
		expect(serialised).not.toContain("hunter2");
		expect(serialised).not.toContain("aHVudGVyMg==");
		expect(decryptMock).not.toHaveBeenCalled();
	});

	it("reports no secret when none is stored", async () => {
		dbMock.projectEnvironment.findMany.mockResolvedValue([
			{
				id: "e1",
				authKind: "NONE",
				authUsername: null,
				authHeaderName: null,
				authUpdatedAt: null,
				encryptedAuthSecret: null,
			},
		]);

		const [summary] = await listEnvironmentAuthSummaries({
			projectId: "p1",
		});
		expect(summary.hasSecret).toBe(false);
	});
});

describe("resolveEnvironmentAuth", () => {
	it("decrypts for the runner and flags a production target", async () => {
		dbMock.projectEnvironment.findFirst.mockResolvedValue({
			type: "PRODUCTION",
			baseUrl: "https://app.acme.com",
			authKind: "FORM",
			authUsername: "qa@acme.test",
			authHeaderName: null,
			encryptedAuthSecret: "aHVudGVyMg==",
		});

		const resolved = await resolveEnvironmentAuth({
			projectId: "p1",
			environmentId: "e1",
		});

		expect(resolved?.secret).toBe("hunter2");
		// Carried so a caller deciding whether to warn or refuse does not have to
		// re-query to learn it is pointing at the customer's live system.
		expect(resolved?.isProduction).toBe(true);
	});

	it("treats an undecryptable secret as absent rather than throwing", async () => {
		// A rotated key or a corrupt row must surface as "no usable credential",
		// which the caller already handles — not as a crashed run.
		decryptMock.mockImplementationOnce(() => {
			throw new Error("bad key");
		});
		dbMock.projectEnvironment.findFirst.mockResolvedValue({
			type: "STAGING",
			baseUrl: "https://staging.acme.com",
			authKind: "TOKEN",
			authUsername: null,
			authHeaderName: null,
			encryptedAuthSecret: "corrupt",
		});

		const resolved = await resolveEnvironmentAuth({
			projectId: "p1",
			environmentId: "e1",
		});

		expect(resolved).not.toBeNull();
		expect(resolved?.secret).toBeNull();
	});

	it("returns null for an environment in another project", async () => {
		dbMock.projectEnvironment.findFirst.mockResolvedValue(null);

		await expect(
			resolveEnvironmentAuth({
				projectId: "p1",
				environmentId: "someone-elses",
			}),
		).resolves.toBeNull();
		expect(
			dbMock.projectEnvironment.findFirst.mock.calls[0][0].where,
		).toEqual({ id: "someone-elses", projectId: "p1" });
	});
});
