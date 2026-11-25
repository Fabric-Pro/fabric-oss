import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	company: vi.fn(),
	provider: vi.fn(),
	decrypt: vi.fn(),
}));

vi.mock("../../client", () => ({
	db: {
		projectContext: { findFirst: mocks.project },
		companyContextSource: { findFirst: mocks.company },
		organizationSearchProvider: { findFirst: mocks.provider },
	},
}));
vi.mock("@repo/utils", () => ({ decryptApiKey: mocks.decrypt }));

import { resolveUrlSourceScraperCredential } from "../search-providers";

const input = {
	contextId: "example-context",
	organizationId: "example-org",
	providerName: "cloudflare",
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.project.mockResolvedValue({ id: input.contextId });
	mocks.company.mockResolvedValue({ id: input.contextId });
	mocks.provider.mockResolvedValue({
		encryptedApiKey: "example-ciphertext",
		endpoint: "example-account",
	});
	mocks.decrypt.mockReturnValue("example-token");
});

describe("resolveUrlSourceScraperCredential", () => {
	it.each([false, true])(
		"scopes the source and enabled provider before decrypting (company=%s)",
		async (company) => {
			const result = await resolveUrlSourceScraperCredential({
				...input,
				company,
			});
			expect(
				company ? mocks.company : mocks.project,
			).toHaveBeenCalledWith({
				where: company
					? {
							id: input.contextId,
							organizationId: input.organizationId,
						}
					: {
							id: input.contextId,
							project: { organizationId: input.organizationId },
						},
				select: { id: true },
			});
			expect(
				company ? mocks.project : mocks.company,
			).not.toHaveBeenCalled();
			expect(mocks.provider).toHaveBeenCalledWith({
				where: {
					organizationId: input.organizationId,
					providerName: input.providerName,
					enabled: true,
				},
				select: { encryptedApiKey: true, endpoint: true },
			});
			expect(result).toEqual({
				status: "resolved",
				apiKey: "example-token",
				endpoint: "example-account",
			});
		},
	);

	it.each(["another-org", null])(
		"does not decrypt a project source owned by %s",
		async (organizationId) => {
			mocks.project.mockImplementation(async ({ where }) =>
				where.project?.organizationId === undefined ||
				where.project.organizationId === organizationId
					? { id: input.contextId }
					: null,
			);
			await expect(
				resolveUrlSourceScraperCredential(input),
			).resolves.toEqual({ status: "source-not-authorized" });
			expect(mocks.provider).not.toHaveBeenCalled();
			expect(mocks.decrypt).not.toHaveBeenCalled();
		},
	);

	it("does not query when the input organization is absent", async () => {
		await expect(
			resolveUrlSourceScraperCredential({
				...input,
				organizationId: null,
			}),
		).resolves.toEqual({ status: "source-not-authorized" });
		expect(mocks.project).not.toHaveBeenCalled();
		expect(mocks.decrypt).not.toHaveBeenCalled();
	});

	it.each(["missing", "disabled", "keyless"])(
		"does not decrypt a %s provider",
		async (state) => {
			mocks.provider.mockImplementation(async ({ where }) => {
				if (
					state === "missing" ||
					(state === "disabled" && where.enabled)
				) {
					return null;
				}
				return {
					encryptedApiKey:
						state === "keyless" ? null : "example-ciphertext",
					endpoint: null,
				};
			});
			await expect(
				resolveUrlSourceScraperCredential(input),
			).resolves.toEqual({ status: "provider-unavailable" });
			expect(mocks.decrypt).not.toHaveBeenCalled();
		},
	);

	it("treats an empty decrypted key as unreadable", async () => {
		mocks.decrypt.mockReturnValue("");
		await expect(resolveUrlSourceScraperCredential(input)).resolves.toEqual(
			{
				status: "credential-unreadable",
			},
		);
	});

	it("returns a status without exposing the decrypt error", async () => {
		mocks.decrypt.mockImplementation(() => {
			throw new Error("example-ciphertext");
		});
		await expect(resolveUrlSourceScraperCredential(input)).resolves.toEqual(
			{ status: "credential-unreadable" },
		);
	});
});
