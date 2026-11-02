import { logger } from "@repo/logs";
import { isEncryptedApiKey } from "@repo/utils";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authOptions } from "../../auth";

const observed = vi.hoisted(() => ({
	encryptionFailure: null as Error | null,
}));

vi.mock("@repo/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/utils")>();
	return {
		...actual,
		encryptApiKey(value: string) {
			if (observed.encryptionFailure) {
				throw observed.encryptionFailure;
			}
			return actual.encryptApiKey(value);
		},
	};
});

type MemoryRow = Record<string, unknown>;
type MemoryData = Record<string, MemoryRow[]>;

const PLAINTEXT_ID_TOKEN = "header.example-payload.signature";
const REPLACEMENT_ID_TOKEN = "header.replacement-payload.signature";
const TEST_SECRET = "example-id-token-hook-secret-at-least-32-characters";

const accountHooks = authOptions.databaseHooks?.account;
if (!accountHooks) {
	throw new Error("Production account database hooks are not configured");
}

function createFixture(data?: MemoryData) {
	const memory: MemoryData =
		data ??
		({
			user: [],
			session: [],
			account: [],
			verification: [],
		} satisfies MemoryData);
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		secret: TEST_SECRET,
		database: memoryAdapter(memory),
		databaseHooks: { account: accountHooks },
		emailAndPassword: { enabled: true },
	} satisfies BetterAuthOptions);
	return { auth, data: memory };
}

const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);

beforeEach(() => {
	vi.stubEnv("BETTER_AUTH_SECRET", TEST_SECRET);
	observed.encryptionFailure = null;
	errorLog.mockClear();
});

afterAll(() => {
	vi.unstubAllEnvs();
	errorLog.mockRestore();
});

describe("Account.idToken encryption hooks", () => {
	it("discards the ID token when create encryption fails without rejecting the write", async () => {
		const failure = new Error("example encryption failure");
		observed.encryptionFailure = failure;
		const { auth, data } = createFixture();
		const context = await auth.$context;

		const created = await context.internalAdapter.createAccount({
			id: "example-social-account",
			accountId: "example-provider-account",
			providerId: "google",
			userId: "example-user",
			idToken: PLAINTEXT_ID_TOKEN,
		});

		expect(created?.idToken).toBeNull();
		expect(data.account[0]?.idToken).toBeNull();
		expect(errorLog).toHaveBeenCalledWith(
			"[Auth] Failed to encrypt idToken on account create — discarding it:",
			failure,
		);
		expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
			PLAINTEXT_ID_TOKEN,
		);
	});

	it("clears the stored ID token when update encryption fails without rejecting the write", async () => {
		const failure = new Error("example encryption failure");
		observed.encryptionFailure = failure;
		const existing = {
			id: "example-social-account",
			accountId: "example-provider-account",
			providerId: "google",
			userId: "example-user",
			idToken: PLAINTEXT_ID_TOKEN,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		const { auth, data } = createFixture({
			user: [],
			session: [],
			account: [existing],
			verification: [],
		});
		const context = await auth.$context;

		const updated = await context.internalAdapter.updateAccount(
			existing.id,
			{ idToken: REPLACEMENT_ID_TOKEN },
		);

		expect(updated?.idToken).toBeNull();
		expect(data.account[0]?.idToken).toBeNull();
		expect(errorLog).toHaveBeenCalledWith(
			"[Auth] Failed to encrypt idToken on account update — discarding it:",
			failure,
		);
		expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
			REPLACEMENT_ID_TOKEN,
		);
	});

	it("stores ciphertext after successful encryption and still signs in", async () => {
		const { auth, data } = createFixture();
		const signedUp = await auth.api.signUpEmail({
			body: {
				name: "Example User",
				email: "dev@example.com",
				password: "Example-password-123!",
			},
		});
		const context = await auth.$context;

		await context.internalAdapter.createAccount({
			id: "example-social-account",
			accountId: "example-provider-account",
			providerId: "google",
			userId: signedUp.user.id,
			idToken: PLAINTEXT_ID_TOKEN,
		});
		const signedIn = await auth.api.signInEmail({
			body: {
				email: "dev@example.com",
				password: "Example-password-123!",
			},
		});

		const stored = data.account.find(
			(row) => row.id === "example-social-account",
		)?.idToken;
		expect(stored).not.toBe(PLAINTEXT_ID_TOKEN);
		expect(isEncryptedApiKey(stored)).toBe(true);
		expect(signedIn.user.email).toBe("dev@example.com");
	});
});
