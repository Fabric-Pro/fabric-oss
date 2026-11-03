import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	flag: vi.fn(),
	resolve: vi.fn(),
	connection: vi.fn(),
}));

vi.mock("@repo/database", () => ({ isFeatureEnabled: m.flag }));
vi.mock("../../src/credential-manager", () => ({
	resolveCredential: m.resolve,
}));
vi.mock("../../src/github/index", () => ({
	getGitHubWorkflowCredential: m.connection,
}));

import {
	readPmCredentialId,
	resolveGitHubProjectsCredential,
} from "../../src/github/projects-credential";

beforeEach(() => {
	vi.clearAllMocks();
	m.flag.mockResolvedValue(true);
	m.connection.mockResolvedValue({
		kind: "oauth",
		token: "connection-token",
	});
});

describe("resolveGitHubProjectsCredential", () => {
	it("uses the credential the project chose, as the caller", async () => {
		m.resolve.mockResolvedValue({
			ok: true,
			value: { token: "saved-pat" },
		});
		expect(
			await resolveGitHubProjectsCredential(
				"user-1",
				"org-example",
				"cred-1",
			),
		).toEqual({ ok: true, token: "saved-pat", source: "credential" });
		expect(m.resolve).toHaveBeenCalledWith(
			expect.objectContaining({
				credentialId: "cred-1",
				actor: expect.objectContaining({
					type: "user",
					userId: "user-1",
					organizationId: "org-example",
				}),
			}),
		);
		expect(m.connection).not.toHaveBeenCalled();
	});

	it("refuses a chosen credential the caller cannot use, never swapping in another", async () => {
		m.resolve.mockResolvedValue({
			ok: false,
			failure: { code: "forbidden" },
		});
		expect(
			await resolveGitHubProjectsCredential(
				"user-1",
				"org-example",
				"cred-1",
			),
		).toEqual({ ok: false, reason: "credential-unusable" });
		expect(m.connection).not.toHaveBeenCalled();
	});

	it("refuses a chosen credential while the manager is off", async () => {
		m.flag.mockResolvedValue(false);
		expect(
			await resolveGitHubProjectsCredential(
				"user-1",
				"org-example",
				"cred-1",
			),
		).toEqual({ ok: false, reason: "credential-manager-off" });
	});

	it("falls back to the caller's GitHub connection without a choice", async () => {
		expect(
			await resolveGitHubProjectsCredential(
				"user-1",
				"org-example",
				null,
			),
		).toEqual({
			ok: true,
			token: "connection-token",
			source: "connection",
		});
		m.connection.mockResolvedValue(null);
		expect(
			await resolveGitHubProjectsCredential("user-1", "org-example"),
		).toEqual({ ok: false, reason: "no-connection" });
	});

	it("reads the chosen credential from the PM context", () => {
		expect(readPmCredentialId({ credentialId: "cred-1" })).toBe("cred-1");
		expect(readPmCredentialId({ credentialId: "" })).toBeNull();
		expect(readPmCredentialId(null)).toBeNull();
	});
});
