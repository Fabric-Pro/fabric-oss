/** Keep every production auth plugin compatible with the generated Prisma schema. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({
	email: vi.fn().mockResolvedValue(true),
	verification: [] as Array<Record<string, unknown>>,
}));

vi.mock("@repo/mail", () => ({ sendEmail: observed.email }));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	const { PrismaClient } = await import(
		"../../../database/prisma/generated/client"
	);
	const client = new PrismaClient({
		adapter: {
			provider: "postgres",
			adapterName: "example-test-adapter",
			connect: async () => {
				throw new Error(
					"This schema test must not open a database connection",
				);
			},
		},
	});
	return {
		...actual,
		getUserByEmail: async () => ({
			id: "example-user",
			email: "dev@example.com",
			name: "Example User",
		}),
		db: {
			// Preserve generated field metadata so the real Prisma adapter checks
			// the entire configured schema without opening a database connection.
			_runtimeDataModel: Reflect.get(client, "_runtimeDataModel"),
			oauthResource: {
				findFirst: async () => null,
				create: async ({
					data,
				}: {
					data: Record<string, unknown>;
				}) => ({
					id: "example-resource",
					...data,
				}),
			},
			verification: {
				create: async ({ data }: { data: Record<string, unknown> }) => {
					const row = { id: "example-verification", ...data };
					observed.verification.push(row);
					return row;
				},
			},
		},
	};
});

beforeAll(() => {
	vi.stubEnv("NEXT_PUBLIC_ENABLE_CAPTCHA", "false");
	vi.stubEnv(
		"BETTER_AUTH_SECRET",
		"example-auth-secret-for-configured-schema-tests",
	);
});

afterAll(() => {
	vi.unstubAllEnvs();
});

it("validates all configured auth tables and fields against generated Prisma models", async () => {
	const { auth } = await import("../../auth");
	const context = await auth.$context;
	expect(context.checkSchema).toBeTypeOf("function");
	await context.checkSchema?.();
});

it("sends a magic link through the production handler with the existing user schema", async () => {
	const { auth } = await import("../../auth");
	const baseURL = String(auth.options.baseURL);
	const response = await auth.handler(
		new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: baseURL,
				cookie: "NEXT_LOCALE=en",
			},
			body: JSON.stringify({
				email: "dev@example.com",
				callbackURL: "/app",
			}),
		}),
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ status: true });
	expect(observed.verification).toHaveLength(1);
	const link = new URL(observed.email.mock.calls[0][0].context.url);
	expect(link.pathname).toBe("/api/auth/magic-link/verify");
	expect(link.searchParams.get("callbackURL")).toBe("/app");
	expect(observed.email).toHaveBeenCalledWith({
		to: "dev@example.com",
		templateId: "magicLink",
		context: { url: link.toString() },
		locale: "en",
	});
	expect(observed.verification[0].identifier).toBe(
		`magic-link:${link.searchParams.get("token")}`,
	);
	expect(JSON.parse(String(observed.verification[0].value))).toEqual({
		type: "magic-link",
		email: "dev@example.com",
	});
});
