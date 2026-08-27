import { describe, expect, it } from "vitest";
import {
	buildPgPoolConfig,
	getDatabaseAuthProvider,
} from "../prisma/adapter-config";

const URL =
	"postgresql://app@ep-test.databricks.example:5432/db?sslmode=require";
const token = () => Promise.resolve("oauth-token");

describe("getDatabaseAuthProvider", () => {
	it("defaults to password when unset", () => {
		expect(getDatabaseAuthProvider({})).toBe("password");
	});

	it("accepts explicit password", () => {
		expect(
			getDatabaseAuthProvider({ DATABASE_AUTH_PROVIDER: "password" }),
		).toBe("password");
	});

	it("accepts databricks-oauth (case/whitespace tolerant)", () => {
		expect(
			getDatabaseAuthProvider({
				DATABASE_AUTH_PROVIDER: " Databricks-OAuth ",
			}),
		).toBe("databricks-oauth");
	});

	it("rejects unknown values loudly", () => {
		expect(() =>
			getDatabaseAuthProvider({ DATABASE_AUTH_PROVIDER: "iam" }),
		).toThrow(/Unsupported DATABASE_AUTH_PROVIDER/);
	});
});

describe("buildPgPoolConfig", () => {
	it("throws when DATABASE_URL is missing", () => {
		expect(() => buildPgPoolConfig({}, token)).toThrow(
			"DATABASE_URL is not set",
		);
	});

	it("password mode: connection string plus pg's own default pool size", () => {
		// `max` is now stated rather than left to pg, so a process that knows its
		// concurrency budget can raise it. The default has to stay at pg's own 10
		// so request handlers behave exactly as they did before it was explicit.
		const config = buildPgPoolConfig({ DATABASE_URL: URL }, token);
		expect(config).toEqual({ connectionString: URL, max: 10 });
	});

	it("password mode: DATABASE_POOL_MAX raises the pool size", () => {
		const config = buildPgPoolConfig(
			{ DATABASE_URL: URL, DATABASE_POOL_MAX: "39" },
			token,
		);
		expect(config).toEqual({ connectionString: URL, max: 39 });
	});

	it("oauth mode carries the pool size too", () => {
		const config = buildPgPoolConfig(
			{
				DATABASE_URL: URL,
				DATABASE_AUTH_PROVIDER: "databricks-oauth",
				DATABASE_POOL_MAX: "12",
			},
			token,
		);
		expect(config.max).toBe(12);
	});

	it("rejects a DATABASE_POOL_MAX that is not a positive integer", () => {
		// Silently falling back to the default would reintroduce the exact
		// starvation this setting exists to prevent, invisibly.
		for (const bad of ["0", "-4", "abc", "7.5"]) {
			expect(() =>
				buildPgPoolConfig(
					{ DATABASE_URL: URL, DATABASE_POOL_MAX: bad },
					token,
				),
			).toThrow("Invalid DATABASE_POOL_MAX");
		}
	});

	it("databricks-oauth mode: async password callback + lifetime recycling", async () => {
		const config = buildPgPoolConfig(
			{ DATABASE_URL: URL, DATABASE_AUTH_PROVIDER: "databricks-oauth" },
			token,
		);
		expect(config.connectionString).toBe(URL);
		expect(config.maxLifetimeSeconds).toBe(6 * 60 * 60);
		expect(typeof config.password).toBe("function");
		await expect(
			(config.password as () => Promise<string>)(),
		).resolves.toBe("oauth-token");
	});

	it("never invokes the token callback eagerly", () => {
		let calls = 0;
		buildPgPoolConfig(
			{ DATABASE_URL: URL, DATABASE_AUTH_PROVIDER: "databricks-oauth" },
			() => {
				calls++;
				return Promise.resolve("t");
			},
		);
		expect(calls).toBe(0);
	});
});
