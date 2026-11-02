import { type BetterAuthOptions, betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import { sessionRevocationOptions } from "../session-revocation-options";

type MemoryRow = Record<string, unknown>;
type MemoryData = Record<string, MemoryRow[]>;

function createResetFixture(options?: { failSessionDeletion?: boolean }) {
	const data: MemoryData = {
		user: [],
		session: [],
		account: [],
		verification: [],
	};
	const base = memoryAdapter(data);
	const events: string[] = [];
	const database = (authOptions: BetterAuthOptions) => {
		const adapter = base(authOptions);
		return new Proxy(adapter, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, receiver);
				if (typeof value !== "function") {
					return value;
				}
				return (...args: unknown[]) => {
					const model = (args[0] as { model?: string } | undefined)
						?.model;
					if (property === "deleteMany" && model === "session") {
						if (options?.failSessionDeletion) {
							throw new Error("session store unavailable");
						}
						return Promise.resolve(
							(
								value as (...parameters: unknown[]) => unknown
							).apply(target, args),
						).then((result) => {
							events.push("sessions-deleted");
							return result;
						});
					}
					return (
						value as (...parameters: unknown[]) => unknown
					).apply(target, args);
				};
			},
		});
	};

	return { data, database, events };
}

async function createResetRequest(options?: { failSessionDeletion?: boolean }) {
	const fixture = createResetFixture(options);
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		secret: "example-password-reset-secret-at-least-32-characters",
		database: fixture.database,
		emailAndPassword: {
			enabled: true,
			revokeSessionsOnPasswordReset:
				sessionRevocationOptions.emailAndPassword
					.revokeSessionsOnPasswordReset,
		},
	});

	await auth.api.signUpEmail({
		body: {
			name: "Example User",
			email: "dev@example.com",
			password: "Example-password-123!",
		},
	});
	const userId = String(fixture.data.user[0]?.id);
	const existingSession = fixture.data.session[0];
	if (!existingSession) {
		throw new Error("Sign-up did not create a session");
	}
	fixture.data.session.push({
		...existingSession,
		id: "existing-session-2",
		token: "existing-session-token-2",
	});
	fixture.data.verification.push({
		id: "password-reset-verification",
		identifier: "reset-password:example-reset-token",
		value: userId,
		expiresAt: new Date(Date.now() + 60_000),
		createdAt: new Date(),
		updatedAt: new Date(),
	});

	const response = await auth.handler(
		new Request("http://localhost:3000/api/auth/reset-password", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:3000",
			},
			body: JSON.stringify({
				newPassword: "New-example-password-456!",
				token: "example-reset-token",
			}),
		}),
	);
	fixture.events.push("response-returned");

	return { ...fixture, response, userId };
}

describe("password reset session revocation", () => {
	it("returns a non-success response when session revocation fails", async () => {
		const { response } = await createResetRequest({
			failSessionDeletion: true,
		});

		expect(response.ok).toBe(false);
		expect(response.status).toBe(500);
	});

	it("deletes every existing session before returning success", async () => {
		const { data, events, response, userId } = await createResetRequest();

		expect(response.status).toBe(200);
		expect(events).toEqual(["sessions-deleted", "response-returned"]);
		expect(data.session.filter((row) => row.userId === userId)).toEqual([]);
	});
});
