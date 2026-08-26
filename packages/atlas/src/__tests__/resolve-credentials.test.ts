/**
 * `resolveRepoCredentials` — bounded retry of the repo-integration read on a
 * TRANSIENT DB connection/auth blip (observed live as `DriverAdapterError:
 * Authentication timed out`, which failed the whole structure activity), while a
 * not-found row, a deterministic Prisma error, a decrypt failure, and any
 * unrelated error are NEVER retried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFindFirst = vi.fn();
const mockDecryptApiKey = vi.fn();

// Stand-in for `Prisma.PrismaClientKnownRequestError` (a deterministic error).
// Defined via `vi.hoisted` so the hoisted `vi.mock` factory below can reference
// it as a value without hitting the temporal-dead-zone.
const { MockPrismaKnownRequestError } = vi.hoisted(() => {
	class MockPrismaKnownRequestError extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message);
			this.name = "PrismaClientKnownRequestError";
			this.code = code;
		}
	}
	return { MockPrismaKnownRequestError };
});

vi.mock("@repo/database", () => ({
	db: {
		projectRepositoryIntegration: {
			findFirst: (...args: unknown[]) => mockFindFirst(...args),
		},
	},
	Prisma: { PrismaClientKnownRequestError: MockPrismaKnownRequestError },
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (...args: unknown[]) => mockDecryptApiKey(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { resolveRepoCredentials } from "../queries";

const integrationRow = {
	provider: "GITHUB",
	repositoryUrl: "https://github.com/acme/widgets",
	repositoryOwner: "acme",
	repositoryName: "widgets",
	defaultBranch: "main",
	azureOrganization: null,
	authMethod: "PAT",
	encryptedPat: "cipher",
	encryptedAccessToken: null,
};

/** A transient driver/connection error carries its signal on `name` + message. */
function transientError(name: string, message: string): Error {
	return Object.assign(new Error(message), { name });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDecryptApiKey.mockReturnValue("decrypted-token");
});

afterEach(() => {
	vi.useRealTimers();
});

describe("resolveRepoCredentials — transient DB retry", () => {
	it("resolves credentials on a clean read (no retry)", async () => {
		mockFindFirst.mockResolvedValue(integrationRow);

		const result = await resolveRepoCredentials("p1", "int-1");

		expect(mockFindFirst).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			provider: "GITHUB",
			owner: "acme",
			repo: "widgets",
			branch: "main",
			token: "decrypted-token",
		});
	});

	it("retries a transient DriverAdapterError, then succeeds", async () => {
		vi.useFakeTimers();
		mockFindFirst
			.mockRejectedValueOnce(
				transientError(
					"DriverAdapterError",
					"Authentication timed out",
				),
			)
			.mockResolvedValue(integrationRow);

		const promise = resolveRepoCredentials("p1", "int-1");
		await vi.runAllTimersAsync();
		const result = await promise;

		// One retry into a fresh read recovered the transient blip.
		expect(mockFindFirst).toHaveBeenCalledTimes(2);
		expect(result?.token).toBe("decrypted-token");
	});

	it("gives up after the attempt cap on a persistent transient error", async () => {
		vi.useFakeTimers();
		mockFindFirst.mockRejectedValue(
			transientError(
				"PrismaClientInitializationError",
				"Can't reach database server at db:5432",
			),
		);

		const promise = resolveRepoCredentials("p1", "int-1");
		// Attach the rejection expectation before draining timers so the backoffs
		// run without surfacing an unhandled rejection.
		const assertion = expect(promise).rejects.toThrow(
			"Can't reach database server",
		);
		await vi.runAllTimersAsync();
		await assertion;

		// Bounded: 3 attempts total (CREDENTIALS_DB_MAX_ATTEMPTS), then propagate.
		expect(mockFindFirst).toHaveBeenCalledTimes(3);
	});

	it("does NOT retry a deterministic Prisma known-request error", async () => {
		mockFindFirst.mockRejectedValue(
			new MockPrismaKnownRequestError(
				"Unique constraint failed",
				"P2002",
			),
		);

		await expect(
			resolveRepoCredentials("p1", "int-1"),
		).rejects.toBeInstanceOf(MockPrismaKnownRequestError);
		expect(mockFindFirst).toHaveBeenCalledTimes(1);
	});

	it("does NOT retry a not-found integration — returns null on the first read", async () => {
		mockFindFirst.mockResolvedValue(null);

		const result = await resolveRepoCredentials("p1", "missing");

		expect(result).toBeNull();
		expect(mockFindFirst).toHaveBeenCalledTimes(1);
	});

	it("does NOT retry an unrelated (non-transient) error — propagates immediately", async () => {
		mockFindFirst.mockRejectedValue(
			new TypeError("cannot read properties of undefined"),
		);

		await expect(resolveRepoCredentials("p1", "int-1")).rejects.toThrow(
			"cannot read properties of undefined",
		);
		expect(mockFindFirst).toHaveBeenCalledTimes(1);
	});
});
