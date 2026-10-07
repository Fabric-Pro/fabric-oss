/**
 * Pins the recovery behaviour of the MCP OAuth credential writes and
 * `clearRefreshFailures`. Writing a fresh grant or a successful refresh MUST
 * reset `status: "HEALTHY"` + `needsReauth: false` + failure counters,
 * otherwise the UI's MCP-server card stays red after a reconnect even though
 * the tokens are valid. Wiping tokens must not touch them.
 *
 * Each write is also fenced: a new grant only lands on the grant generation
 * its flow started from, a refresh only on the generation and refresh token
 * it spent, and `clearRefreshFailures` only on the generation that succeeded.
 *
 * See `.changeset/mcp-status-reset-on-token-write.md`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMock = vi.fn();
const updateManyMock = vi.fn();
const findUniqueMock = vi.fn();

vi.mock("../prisma/client", () => ({
	Prisma: {
		DbNull: "DbNull",
		PrismaClientKnownRequestError: class extends Error {
			code = "";
		},
	},
	db: {
		mCPConfig: {
			update: (...args: unknown[]) => updateMock(...args),
			updateMany: (...args: unknown[]) => updateManyMock(...args),
			findUnique: (...args: unknown[]) => findUniqueMock(...args),
		},
	},
}));

import { Prisma } from "../prisma/client";

// `ct:<plaintext>` decrypts to `<plaintext>`; `ct:corrupt` cannot be
// decrypted. The hash is deterministic, like the real HMAC.
vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => {
		if (value === "ct:corrupt") {
			throw new Error("cannot decrypt");
		}
		return value.replace(/^ct(?:-v\d+)?:/, "");
	},
	hashApiKey: (value: string) => `hash:${value}`,
}));

import {
	buildMcpOAuthBinding,
	credentialFingerprint,
	withCredentialFingerprint,
} from "../prisma/queries/lib/mcp-oauth-binding";
import { clearRefreshFailures } from "../prisma/queries/mcp";
import {
	importMcpOAuthTokens,
	type McpOAuthImportedTokens,
	type McpOAuthStoredAccessToken,
	replaceMcpOAuthRegistration,
	saveMcpOAuthGrant,
	saveMcpOAuthRefresh,
	wipeMcpOAuthTokens,
} from "../prisma/queries/mcp-oauth-credentials";

/** The mocked `Prisma.PrismaClientKnownRequestError` class. */
const PrismaErrorClass = () =>
	Prisma.PrismaClientKnownRequestError as unknown as new (
		message: string,
	) => Error;

const BREAKER_RESET = {
	status: "HEALTHY",
	needsReauth: false,
	refreshFailureCount: 0,
	lastRefreshFailedAt: null,
	lastRefreshError: null,
	consecutiveFailures: 0,
};

const binding = buildMcpOAuthBinding({
	authorizationServerUrl: "https://as.example.com",
	tokenEndpoint: "https://as.example.com/token",
	source: "discovery",
});

/** The client stored on the row the writes below are fenced on. */
const storedClient = {
	oauthClientId: "client-1",
	encryptedOauthClientSecret: "ct:secret-1",
};

/** What an import read: a row with no client and no binding. */
const noStoredCredentials = {
	oauthClientId: null,
	encryptedOauthClientSecret: null,
	encryptedRefreshToken: null,
	oauthBinding: null,
};

beforeEach(() => {
	findUniqueMock.mockReset();
	updateMock.mockReset();
	updateMock.mockResolvedValue({ oauthGrantGeneration: 4 });
	updateManyMock.mockReset();
	updateManyMock.mockResolvedValue({ count: 1 });
});

describe("saveMcpOAuthGrant — a new grant", () => {
	it("writes tokens and binding, resets the breaker and moves the generation, only on the generation the flow started from", async () => {
		const expires = new Date("2026-06-01T00:00:00Z");
		const result = await saveMcpOAuthGrant({
			configId: "cfg_1",
			expectedGeneration: 3,
			binding,
			tokens: {
				encryptedAccessToken: "ct:abc",
				accessTokenHash: "hash:abc",
				encryptedRefreshToken: "rt:xyz",
				tokenExpiresAt: expires,
			},
			client: storedClient,
		});

		// The row as written comes back, so the caller never re-reads.
		expect(result).toMatchObject({ written: true, generation: 4 });
		expect(result.config).toEqual({ oauthGrantGeneration: 4 });
		expect(updateMock).toHaveBeenCalledTimes(1);
		const callArg = updateMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		};
		// Fenced on the generation AND the client the code was exchanged with.
		expect(callArg.where).toEqual({
			id: "cfg_1",
			oauthGrantGeneration: 3,
			...storedClient,
		});
		expect(callArg.data).toMatchObject({
			encryptedAccessToken: "ct:abc",
			accessTokenHash: "hash:abc",
			encryptedRefreshToken: "rt:xyz",
			tokenExpiresAt: expires,
			// The binding carries the fingerprint of the set now stored.
			oauthBinding: withCredentialFingerprint(binding, {
				...storedClient,
				encryptedRefreshToken: "rt:xyz",
			}),
			oauthGrantGeneration: { increment: 1 },
			...BREAKER_RESET,
		});
	});
});

describe("saveMcpOAuthRefresh — a refresh result", () => {
	it("is a compare-and-set on generation and spent refresh token that resets the breaker and keeps the generation", async () => {
		const outcome = await saveMcpOAuthRefresh({
			configId: "cfg_1",
			expectedGeneration: 3,
			expectedRefreshToken: "rt:spent",
			tokens: {
				encryptedAccessToken: "ct:new",
				accessTokenHash: "hash:new",
				encryptedRefreshToken: "rt:rotated",
				tokenExpiresAt: null,
			},
			binding: withCredentialFingerprint(binding, {
				...storedClient,
				encryptedRefreshToken: "rt:spent",
			}),
			client: storedClient,
		});

		expect(outcome).toBe("written");
		const callArg = updateManyMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		};
		expect(callArg.where).toEqual({
			id: "cfg_1",
			oauthGrantGeneration: 3,
			encryptedRefreshToken: "rt:spent",
			// And on the client it authenticated with.
			...storedClient,
		});
		expect(callArg.data).toMatchObject({
			encryptedAccessToken: "ct:new",
			encryptedRefreshToken: "rt:rotated",
			...BREAKER_RESET,
		});
		expect(callArg.data).not.toHaveProperty("oauthGrantGeneration");
		// Same binding, re-fingerprinted for the credential set now stored
		// (rotation updates it in the same compare-and-set write).
		expect(callArg.data.oauthBinding).toEqual({
			...binding,
			credentialFingerprint: credentialFingerprint({
				...storedClient,
				encryptedRefreshToken: "rt:rotated",
			}),
		});
	});

	it("reports a lost race as superseded", async () => {
		updateManyMock.mockResolvedValue({ count: 0 });

		const outcome = await saveMcpOAuthRefresh({
			configId: "cfg_1",
			expectedGeneration: 3,
			expectedRefreshToken: "rt:spent",
			tokens: {
				encryptedAccessToken: "ct:new",
				accessTokenHash: "hash:new",
				encryptedRefreshToken: "rt:rotated",
				tokenExpiresAt: null,
			},
			binding: withCredentialFingerprint(binding, {
				...storedClient,
				encryptedRefreshToken: "rt:spent",
			}),
			client: storedClient,
		});

		expect(outcome).toBe("superseded");
	});
});

describe("wipeMcpOAuthTokens — clearing tokens", () => {
	it("clears tokens and moves the generation without touching status fields", async () => {
		findUniqueMock.mockResolvedValue({
			...storedClient,
			encryptedRefreshToken: "rt:old",
			oauthBinding: null,
		});
		await wipeMcpOAuthTokens({ configId: "cfg_1" });

		const callArg = updateManyMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(callArg.data).toMatchObject({
			encryptedAccessToken: null,
			accessTokenHash: null,
			encryptedRefreshToken: null,
			tokenExpiresAt: null,
			oauthGrantGeneration: { increment: 1 },
		});
		expect(callArg.data).not.toHaveProperty("status");
		expect(callArg.data).not.toHaveProperty("needsReauth");
		expect(callArg.data).not.toHaveProperty("refreshFailureCount");
		// Only the connect flow rebinds.
		expect(callArg.data).not.toHaveProperty("oauthBinding");
	});

	it("writes no binding (so no fingerprint) when the kept client is unbound and holds a secret", async () => {
		findUniqueMock.mockResolvedValue({
			...storedClient,
			encryptedRefreshToken: "rt:old",
			oauthBinding: {
				mode: "bearer-only",
				importedAt: "2026-10-06T00:00:00.000Z",
			},
		});
		await wipeMcpOAuthTokens({ configId: "cfg_1" });

		const callArg = updateManyMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(callArg.data).not.toHaveProperty("oauthBinding");
	});

	it("keeps a binding re-fingerprinted for the client it keeps, fenced on that client", async () => {
		findUniqueMock.mockResolvedValue({
			...storedClient,
			encryptedRefreshToken: "rt:old",
			oauthBinding: withCredentialFingerprint(binding, {
				...storedClient,
				encryptedRefreshToken: "rt:old",
			}),
		});
		await wipeMcpOAuthTokens({ configId: "cfg_1" });

		const callArg = updateManyMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		};
		expect(callArg.where).toMatchObject(storedClient);
		expect(callArg.data.oauthBinding).toEqual(
			withCredentialFingerprint(binding, {
				...storedClient,
				encryptedRefreshToken: null,
			}),
		);
	});

	it("never launders a client replaced outside the module: its binding loses the fingerprint", async () => {
		// The binding was written for client-1 / secret-1; a legacy writer
		// then replaced the secret under the same id.
		findUniqueMock.mockResolvedValue({
			...storedClient,
			encryptedOauthClientSecret: "ct:legacy-secret",
			encryptedRefreshToken: "rt:old",
			oauthBinding: withCredentialFingerprint(binding, {
				...storedClient,
				encryptedRefreshToken: "rt:old",
			}),
		});
		await wipeMcpOAuthTokens({ configId: "cfg_1" });

		const callArg = updateManyMock.mock.calls[0]?.[0] as {
			data: { oauthBinding: Record<string, unknown> };
		};
		expect(callArg.data.oauthBinding).not.toHaveProperty(
			"credentialFingerprint",
		);
		expect(callArg.data.oauthBinding).toMatchObject({
			authorizationServerUrl: binding.authorizationServerUrl,
		});
	});
});

describe("importMcpOAuthTokens — the binding's credential fingerprint", () => {
	const tokens = {
		encryptedAccessToken: "ct:imported",
		accessTokenHash: "hash:imported",
		encryptedRefreshToken: "ct:imported-refresh",
		tokenExpiresAt: null,
	};

	it("fingerprints the import binding over the kept client and the imported refresh token, fenced on that client", async () => {
		const stored = {
			...storedClient,
			encryptedRefreshToken: "ct:old-refresh",
			oauthBinding: withCredentialFingerprint(binding, {
				...storedClient,
				encryptedRefreshToken: "ct:old-refresh",
			}),
		};
		await importMcpOAuthTokens({
			configId: "cfg_1",
			stored,
			expectedGeneration: 3,
			tokens,
			binding,
		});

		const { where, data } = updateMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		};
		expect(where).toMatchObject(storedClient);
		expect(data.oauthBinding).toEqual(
			withCredentialFingerprint(binding, {
				...storedClient,
				encryptedRefreshToken: "ct:imported-refresh",
			}),
		);
	});

	it.each([
		["no binding", null],
		[
			"a bearer-only marker",
			{ mode: "bearer-only", importedAt: "2026-10-06T00:00:00.000Z" },
		],
	])(
		"never fingerprints an UNBOUND kept client holding a secret (%s)",
		async (_label, oauthBinding) => {
			await importMcpOAuthTokens({
				configId: "cfg_1",
				stored: {
					...storedClient,
					encryptedRefreshToken: "ct:old-refresh",
					oauthBinding,
				},
				expectedGeneration: 3,
				tokens,
				binding,
			});

			const { data } = updateMock.mock.calls[0]?.[0] as {
				data: { oauthBinding: Record<string, unknown> };
			};
			// Nothing could ever send it: the import is stored bearer-only.
			expect(data.oauthBinding).toMatchObject({ mode: "bearer-only" });
			expect(data.oauthBinding).not.toHaveProperty(
				"credentialFingerprint",
			);
		},
	);

	it("fingerprints an UNBOUND kept public client (no secret)", async () => {
		const publicClient = {
			oauthClientId: "public-client",
			encryptedOauthClientSecret: null,
		};
		await importMcpOAuthTokens({
			configId: "cfg_1",
			stored: {
				...publicClient,
				encryptedRefreshToken: null,
				oauthBinding: null,
			},
			expectedGeneration: 3,
			tokens,
			binding,
		});

		const { data } = updateMock.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(data.oauthBinding).toEqual(
			withCredentialFingerprint(binding, {
				...publicClient,
				encryptedRefreshToken: "ct:imported-refresh",
			}),
		);
	});

	it("does not launder a kept client that no longer matched its binding", async () => {
		const stored = {
			...storedClient,
			oauthClientId: "legacy-client",
			encryptedRefreshToken: "ct:old-refresh",
			oauthBinding: withCredentialFingerprint(binding, {
				...storedClient,
				encryptedRefreshToken: "ct:old-refresh",
			}),
		};
		await importMcpOAuthTokens({
			configId: "cfg_1",
			stored,
			expectedGeneration: 3,
			tokens,
			binding,
		});

		const { data } = updateMock.mock.calls[0]?.[0] as {
			data: { oauthBinding: Record<string, unknown> };
		};
		expect(data.oauthBinding).not.toHaveProperty("credentialFingerprint");
	});
});

describe("a write that keeps the stored client never re-points it at another AS", () => {
	const elsewhere = buildMcpOAuthBinding({
		authorizationServerUrl: "https://as-other.example.com",
		tokenEndpoint: "https://as-other.example.com/token",
		source: "catalog",
	});
	const kept = {
		...storedClient,
		encryptedRefreshToken: "ct:old-refresh",
		oauthBinding: withCredentialFingerprint(binding, {
			...storedClient,
			encryptedRefreshToken: "ct:old-refresh",
		}),
	};
	const tokens = {
		encryptedAccessToken: "ct:imported",
		accessTokenHash: "hash:imported",
		encryptedRefreshToken: "ct:imported-refresh",
		tokenExpiresAt: null,
	};
	const keptRegistration = {
		...storedClient,
		dcrClientMetadata: null,
		dcrRegistrationEndpoint: null,
		dcrRegisteredAt: null,
	};
	const written = () =>
		(updateMock.mock.calls[0]?.[0] as { data: Record<string, unknown> })
			.data;

	it("an import under another AS's binding is stored bearer-only", async () => {
		await importMcpOAuthTokens({
			configId: "cfg_1",
			stored: kept,
			expectedGeneration: 3,
			tokens,
			binding: elsewhere,
		});

		expect(written().oauthBinding).toMatchObject({ mode: "bearer-only" });
	});

	it("an import under a binding to the same AS but another token endpoint is stored bearer-only", async () => {
		await importMcpOAuthTokens({
			configId: "cfg_1",
			stored: kept,
			expectedGeneration: 3,
			tokens,
			binding: {
				...binding,
				tokenEndpoint: "https://as.example.com/other",
			},
		});

		expect(written().oauthBinding).toMatchObject({ mode: "bearer-only" });
	});

	it("a registration replacement keeping the client under another AS: bearer-only with tokens, unbound without", async () => {
		await replaceMcpOAuthRegistration({
			configId: "cfg_1",
			expectedGeneration: 3,
			client: keptRegistration,
			keptClient: kept,
			binding: elsewhere,
			tokens,
		});
		expect(written().oauthBinding).toMatchObject({ mode: "bearer-only" });

		updateMock.mockClear();
		await replaceMcpOAuthRegistration({
			configId: "cfg_1",
			expectedGeneration: 3,
			client: keptRegistration,
			keptClient: kept,
			binding: elsewhere,
		});
		expect(written().oauthBinding).toBe("DbNull");
	});

	it("keeping the client under the binding it was verified for stays fingerprinted, fenced on that client", async () => {
		await replaceMcpOAuthRegistration({
			configId: "cfg_1",
			expectedGeneration: 3,
			client: keptRegistration,
			keptClient: kept,
			binding,
		});

		const call = updateMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		};
		expect(call.where).toMatchObject(storedClient);
		expect(call.data.oauthBinding).toEqual(
			withCredentialFingerprint(binding, {
				...storedClient,
				encryptedRefreshToken: null,
			}),
		);
	});
});

describe("clearRefreshFailures — symmetric status restore", () => {
	it("resets status to HEALTHY + failure counters + needsReauth: false, only on the given generation", async () => {
		const applied = await clearRefreshFailures("cfg_1", {
			expectedGeneration: 2,
		});

		expect(applied).toBe(true);
		expect(updateMock).not.toHaveBeenCalled();
		const callArg = updateManyMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		};

		expect(callArg.where).toEqual({ id: "cfg_1", oauthGrantGeneration: 2 });
		expect(callArg.data).toMatchObject(BREAKER_RESET);
	});

	it("changes nothing for a generation the config has moved past", async () => {
		updateManyMock.mockResolvedValue({ count: 0 });

		await expect(
			clearRefreshFailures("cfg_1", { expectedGeneration: 1 }),
		).resolves.toBe(false);
	});
});

/**
 * A hand-imported token set holding a usable access token is a new grant:
 * the same write that stores it resets the breaker, as the callback does. A
 * set that installs no usable access token resets nothing, and the
 * generation fence still decides whether anything is written at all.
 */
describe("importMcpOAuthTokens / replaceMcpOAuthRegistration — a usable imported grant resets the breaker", () => {
	const usable = {
		encryptedAccessToken: "ct:imported",
		accessTokenHash: "hash:imported",
		encryptedRefreshToken: null,
		tokenExpiresAt: null,
	};
	const client = {
		oauthClientId: "manual-client",
		encryptedOauthClientSecret: "ct:secret",
		dcrClientMetadata: null,
		dcrRegistrationEndpoint: null,
		dcrRegisteredAt: null,
	};
	// What the flagged config (`needsReauth`, UNAVAILABLE, strikes) held when
	// the caller read it at generation 3: an expired access token.
	const storedExpiry = new Date(Date.now() - 3_600_000);
	const stored = {
		encryptedAccessToken: "ct:stored-v1",
		accessTokenHash: "hash:stored",
		tokenExpiresAt: storedExpiry,
	};

	function writeArg(): {
		where: Record<string, unknown>;
		data: Record<string, unknown>;
	} {
		expect(updateMock).toHaveBeenCalledTimes(1);
		return updateMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		};
	}

	it.each([
		[
			"importMcpOAuthTokens",
			() =>
				importMcpOAuthTokens({
					configId: "cfg_1",
					stored: noStoredCredentials,
					expectedGeneration: 3,
					storedAccessToken: stored,
					accessTokenSource: "plaintext",
					tokens: usable,
					binding: {
						mode: "bearer-only",
						importedAt: "2026-10-06T00:00:00.000Z",
					},
				}),
		],
		[
			"importMcpOAuthTokens (expiry in the future)",
			() =>
				importMcpOAuthTokens({
					configId: "cfg_1",
					stored: noStoredCredentials,
					expectedGeneration: 3,
					storedAccessToken: stored,
					accessTokenSource: "plaintext",
					tokens: {
						...usable,
						tokenExpiresAt: new Date(Date.now() + 60_000),
					},
					binding: null,
				}),
		],
		[
			"replaceMcpOAuthRegistration",
			() =>
				replaceMcpOAuthRegistration({
					configId: "cfg_1",
					expectedGeneration: 3,
					storedAccessToken: stored,
					accessTokenSource: "plaintext",
					client,
					binding: null,
					tokens: usable,
				}),
		],
	])(
		"%s with a NEW usable access token resets the breaker in the same fenced write",
		async (_label, write) => {
			await write();

			const { where, data } = writeArg();
			expect(data).toMatchObject(BREAKER_RESET);
			expect(data.oauthGrantGeneration).toEqual({ increment: 1 });
			// Fenced on the generation AND the stored token it compared with.
			expect(where).toMatchObject({
				id: "cfg_1",
				oauthGrantGeneration: 3,
				encryptedAccessToken: "ct:stored-v1",
			});
		},
	);

	describe("the stored token echoed back is not a new grant", () => {
		const echoes = [
			[
				"the identical ciphertext",
				{
					encryptedAccessToken: "ct:stored-v1",
					accessTokenHash: "hash:stored",
					encryptedRefreshToken: "ct:stored-refresh",
					tokenExpiresAt: null,
				},
			],
			[
				"a re-encryption of the same token (same hash)",
				{
					encryptedAccessToken: "ct:stored-v2",
					accessTokenHash: "hash:stored",
					encryptedRefreshToken: "ct:stored-refresh",
					tokenExpiresAt: null,
				},
			],
		] as const;

		for (const [label, tokens] of echoes) {
			it(`importMcpOAuthTokens with ${label} resets nothing and keeps the known expiry`, async () => {
				await importMcpOAuthTokens({
					configId: "cfg_1",
					stored: noStoredCredentials,
					expectedGeneration: 3,
					storedAccessToken: stored,
					tokens,
					binding: null,
				});

				const { data } = writeArg();
				for (const column of Object.keys(BREAKER_RESET)) {
					expect(data).not.toHaveProperty(column);
				}
				expect(data.tokenExpiresAt).toBe(storedExpiry);
			});

			it(`replaceMcpOAuthRegistration with ${label} resets nothing and keeps the known expiry`, async () => {
				await replaceMcpOAuthRegistration({
					configId: "cfg_1",
					expectedGeneration: 3,
					storedAccessToken: stored,
					client,
					binding: null,
					tokens,
				});

				const { data } = writeArg();
				for (const column of Object.keys(BREAKER_RESET)) {
					expect(data).not.toHaveProperty(column);
				}
				expect(data.tokenExpiresAt).toBe(storedExpiry);
			});
		}

		it("a caller-supplied expiry cannot extend a known one", async () => {
			await importMcpOAuthTokens({
				configId: "cfg_1",
				stored: noStoredCredentials,
				expectedGeneration: 3,
				storedAccessToken: stored,
				tokens: {
					...echoes[1][1],
					tokenExpiresAt: new Date(Date.now() + 86_400_000),
				},
				binding: null,
			});

			expect(writeArg().data.tokenExpiresAt).toBe(storedExpiry);
		});

		it("a stored token with no known expiry takes the caller's", async () => {
			const supplied = new Date(Date.now() + 60_000);
			await importMcpOAuthTokens({
				configId: "cfg_1",
				stored: noStoredCredentials,
				expectedGeneration: 3,
				storedAccessToken: { ...stored, tokenExpiresAt: null },
				tokens: { ...echoes[1][1], tokenExpiresAt: supplied },
				binding: null,
			});

			const { data } = writeArg();
			expect(data.tokenExpiresAt).toBe(supplied);
			expect(data).not.toHaveProperty("needsReauth");
		});
	});

	it.each([
		[
			"an already-expired access token",
			() =>
				importMcpOAuthTokens({
					configId: "cfg_1",
					stored: noStoredCredentials,
					expectedGeneration: 3,
					storedAccessToken: stored,
					tokens: {
						...usable,
						tokenExpiresAt: new Date(Date.now() - 60_000),
					},
					binding: null,
				}),
		],
		[
			"an access token with no hash (cannot be identified)",
			() =>
				importMcpOAuthTokens({
					configId: "cfg_1",
					stored: noStoredCredentials,
					expectedGeneration: 3,
					storedAccessToken: stored,
					tokens: { ...usable, accessTokenHash: null },
					binding: null,
				}),
		],
		[
			"a refresh token only",
			() =>
				importMcpOAuthTokens({
					configId: "cfg_1",
					stored: noStoredCredentials,
					expectedGeneration: 3,
					storedAccessToken: stored,
					tokens: {
						encryptedAccessToken: null,
						accessTokenHash: null,
						encryptedRefreshToken: "ct:refresh",
						tokenExpiresAt: null,
					},
					binding: null,
				}),
		],
		[
			"a registration replacement that clears the tokens",
			() =>
				replaceMcpOAuthRegistration({
					configId: "cfg_1",
					expectedGeneration: 3,
					storedAccessToken: stored,
					client,
					binding: null,
					tokens: null,
				}),
		],
		[
			"a client removal",
			() =>
				replaceMcpOAuthRegistration({
					configId: "cfg_1",
					expectedGeneration: 3,
					client: null,
					binding: null,
				}),
		],
		[
			"an import with no stored token to compare with",
			() =>
				importMcpOAuthTokens({
					configId: "cfg_1",
					stored: noStoredCredentials,
					expectedGeneration: 3,
					tokens: usable,
					binding: null,
				}),
		],
	])("%s resets nothing", async (_label, write) => {
		await write();

		const { data } = writeArg();
		for (const column of Object.keys(BREAKER_RESET)) {
			expect(data).not.toHaveProperty(column);
		}
	});

	describe("how the token arrived decides, not mutable stored state", () => {
		const writers = [
			[
				"importMcpOAuthTokens",
				(args: {
					storedAccessToken: McpOAuthStoredAccessToken;
					accessTokenSource: "plaintext" | "ciphertext";
					tokens: McpOAuthImportedTokens;
				}) =>
					importMcpOAuthTokens({
						configId: "cfg_1",
						stored: noStoredCredentials,
						expectedGeneration: 3,
						binding: null,
						...args,
					}),
			],
			[
				"replaceMcpOAuthRegistration",
				(args: {
					storedAccessToken: McpOAuthStoredAccessToken;
					accessTokenSource: "plaintext" | "ciphertext";
					tokens: McpOAuthImportedTokens;
				}) =>
					replaceMcpOAuthRegistration({
						configId: "cfg_1",
						expectedGeneration: 3,
						client,
						binding: null,
						...args,
					}),
			],
		] as const;

		const noBreakerColumns = () => {
			const { data } = writeArg();
			for (const column of Object.keys(BREAKER_RESET)) {
				expect(data).not.toHaveProperty(column);
			}
			return data;
		};

		for (const [name, write] of writers) {
			it(`${name}: a ciphertext never resets, even into a row with no stored token (clear, then replay)`, async () => {
				await write({
					storedAccessToken: {
						encryptedAccessToken: null,
						accessTokenHash: null,
						tokenExpiresAt: null,
					},
					accessTokenSource: "ciphertext",
					tokens: {
						encryptedAccessToken: "ct:stored-plain",
						accessTokenHash: "hash:stored-plain",
						encryptedRefreshToken: null,
						tokenExpiresAt: null,
					},
				});

				noBreakerColumns();
			});

			it(`${name}: a ciphertext into a row holding another token keeps the stored expiry`, async () => {
				await write({
					storedAccessToken: stored,
					accessTokenSource: "ciphertext",
					tokens: {
						encryptedAccessToken: "ct:other",
						accessTokenHash: "hash:other",
						encryptedRefreshToken: null,
						tokenExpiresAt: null,
					},
				});

				expect(noBreakerColumns().tokenExpiresAt).toBe(storedExpiry);
			});

			it(`${name}: the same plaintext re-imported over a stored row without a hash does not reset`, async () => {
				await write({
					storedAccessToken: {
						encryptedAccessToken: "ct-v1:same-plain",
						accessTokenHash: null,
						tokenExpiresAt: storedExpiry,
					},
					accessTokenSource: "plaintext",
					tokens: {
						encryptedAccessToken: "ct-v2:same-plain",
						accessTokenHash: "hash:same-plain",
						encryptedRefreshToken: null,
						tokenExpiresAt: null,
					},
				});

				expect(noBreakerColumns().tokenExpiresAt).toBe(storedExpiry);
			});

			it(`${name}: a stored token that cannot be decrypted to compare does not reset`, async () => {
				await write({
					storedAccessToken: {
						encryptedAccessToken: "ct:corrupt",
						accessTokenHash: null,
						tokenExpiresAt: null,
					},
					accessTokenSource: "plaintext",
					tokens: usable,
				});

				noBreakerColumns();
			});

			it(`${name}: a different plaintext over a stored row without a hash still resets`, async () => {
				await write({
					storedAccessToken: {
						encryptedAccessToken: "ct-v1:old-plain",
						accessTokenHash: null,
						tokenExpiresAt: storedExpiry,
					},
					accessTokenSource: "plaintext",
					tokens: usable,
				});

				expect(writeArg().data).toMatchObject(BREAKER_RESET);
			});
		}
	});

	it("a stale generation or a token changed since the read writes nothing, so nothing is reset", async () => {
		updateMock.mockRejectedValue(
			Object.assign(new (PrismaErrorClass())("no row"), {
				code: "P2025",
			}),
		);

		const result = await importMcpOAuthTokens({
			configId: "cfg_1",
			stored: noStoredCredentials,
			expectedGeneration: 2,
			storedAccessToken: stored,
			tokens: usable,
			binding: null,
		});

		expect(result).toEqual({
			written: false,
			generation: null,
			config: null,
		});
		expect(writeArg().where).toMatchObject({
			oauthGrantGeneration: 2,
			encryptedAccessToken: "ct:stored-v1",
		});
		expect(updateManyMock).not.toHaveBeenCalled();
	});
});
