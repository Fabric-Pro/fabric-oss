/**
 * Credentials are kept per deployment (Fizzy #2878): config version 2 keys a
 * profile by the origin of the deployment it signs in to, a browser sign-in
 * records the issuer that granted it, and a version 1 file, whose profiles were
 * named and each carried a `baseUrl`, is re-keyed on read without being
 * rewritten until something is saved.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalAppData = process.env.APPDATA;

async function isolatedConfigHome(): Promise<void> {
	const home = await mkdtemp(path.join(tmpdir(), "fabric-config-origins-"));
	process.env.XDG_CONFIG_HOME = home;
	process.env.APPDATA = home;
}

afterEach(() => {
	if (originalConfigHome === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalConfigHome;
	}
	if (originalAppData === undefined) {
		delete process.env.APPDATA;
	} else {
		process.env.APPDATA = originalAppData;
	}
	delete process.env.FABRIC_API_KEY;
	vi.resetModules();
});

const STAGING = "https://staging.example";
const PRODUCTION = "https://fabric.pro";

function sessionFor(origin: string, accessToken: string) {
	return {
		issuer: origin,
		clientId: `client-${accessToken}`,
		redirectUri: "http://127.0.0.1:49152/callback",
		tokenEndpoint: `${origin}/api/auth/oauth2/token`,
		accessToken,
		refreshToken: `refresh-${accessToken}`,
		expiresAt: 1_900_000_000_000,
	};
}

/** A file as version 1 of the CLI wrote it: named profiles, no issuer, no version. */
async function writeVersionOne(
	file: string,
	body: Record<string, unknown>,
): Promise<void> {
	await writeFile(file, JSON.stringify(body));
}

async function configWith(body: Record<string, unknown>) {
	await isolatedConfigHome();
	const probe = await import("../src/lib/config.js");
	const file = probe.getConfigPath();
	await writeVersionOne(file, body);
	vi.resetModules();
	return { config: await import("../src/lib/config.js"), file };
}

describe("a version 1 file, re-keyed on read", () => {
	const V1_OAUTH = {
		clientId: "client-example",
		redirectUri: "http://127.0.0.1:49152/callback",
		tokenEndpoint: `${STAGING}/api/auth/oauth2/token`,
		accessToken: "fat_staging",
		refreshToken: "frt_staging",
		expiresAt: 1_900_000_000_000,
	};

	it("finds a named profile's sign-in under its deployment's origin, with the issuer its token endpoint names", async () => {
		const { config } = await configWith({
			activeProfile: "staging",
			profiles: { staging: { baseUrl: STAGING, oauth: V1_OAUTH } },
			defaultFormat: "table",
		});

		expect(config.getOAuth(STAGING)).toEqual({
			...V1_OAUTH,
			issuer: STAGING,
		});
		expect(config.getActiveOrigin()).toBe(STAGING);
		expect(config.getBaseUrl()).toBe(STAGING);
	});

	it("puts a profile with no baseUrl under the default deployment", async () => {
		const { config } = await configWith({
			activeProfile: "default",
			profiles: { default: { apiKey: "fab_key" } },
			defaultFormat: "table",
		});

		expect(config.getApiKey(PRODUCTION)).toBe("fab_key");
		expect(config.getActiveOrigin()).toBe(PRODUCTION);
	});

	it("keeps each deployment's credential to itself", async () => {
		const { config } = await configWith({
			activeProfile: "default",
			profiles: {
				default: { apiKey: "fab_production" },
				staging: { baseUrl: STAGING, apiKey: "fab_staging" },
			},
			defaultFormat: "table",
		});

		expect(config.getApiKey(PRODUCTION)).toBe("fab_production");
		expect(config.getApiKey(STAGING)).toBe("fab_staging");
		expect(config.getApiKey("https://other.example")).toBeUndefined();
		expect(config.getOAuth("https://other.example")).toBeUndefined();
	});

	it("lets the active profile win when two named profiles share a deployment", async () => {
		const { config } = await configWith({
			activeProfile: "second",
			profiles: {
				first: { baseUrl: STAGING, apiKey: "fab_first" },
				second: { baseUrl: STAGING, apiKey: "fab_second" },
			},
			defaultFormat: "table",
		});

		expect(config.getApiKey(STAGING)).toBe("fab_second");
	});

	it("writes nothing until something is saved", async () => {
		const { config, file } = await configWith({
			activeProfile: "default",
			profiles: { default: { apiKey: "fab_key" } },
			defaultFormat: "table",
		});
		const before = await readFile(file, "utf8");

		config.getApiKey(PRODUCTION);
		config.getOAuth(PRODUCTION);
		config.getBaseUrl();

		expect(await readFile(file, "utf8")).toBe(before);
		expect(JSON.parse(before).version).toBeUndefined();
	});

	it("saves as version 2 on the first write, keeping what was there", async () => {
		const { config, file } = await configWith({
			activeProfile: "staging",
			profiles: {
				staging: {
					baseUrl: STAGING,
					apiKey: "fab_staging",
					defaultContext: { type: "org", slug: "example-org" },
				},
			},
			defaultFormat: "json",
		});

		config.saveDefaultContext({ type: "personal" });

		const saved = JSON.parse(await readFile(file, "utf8"));
		expect(saved.version).toBe(2);
		expect(saved.activeProfile).toBe(STAGING);
		expect(saved.defaultFormat).toBe("json");
		expect(saved.profiles[STAGING]).toEqual({
			baseUrl: STAGING,
			apiKey: "fab_staging",
			defaultContext: { type: "personal" },
		});
	});
});

describe("saving a credential", () => {
	it("keeps another deployment's credential when one signs in elsewhere", async () => {
		await isolatedConfigHome();
		const config = await import("../src/lib/config.js");
		config.saveOAuth(sessionFor(PRODUCTION, "fat_production"), {
			baseUrl: PRODUCTION,
		});

		config.saveOAuth(sessionFor(STAGING, "fat_staging"), {
			baseUrl: STAGING,
		});

		expect(config.getOAuth(PRODUCTION)?.accessToken).toBe("fat_production");
		expect(config.getOAuth(STAGING)?.accessToken).toBe("fat_staging");
		expect(config.getActiveOrigin()).toBe(STAGING);
	});

	it("records the issuer with the sign-in", async () => {
		await isolatedConfigHome();
		const config = await import("../src/lib/config.js");

		config.saveOAuth(sessionFor(STAGING, "fat_staging"), {
			baseUrl: STAGING,
		});

		expect(config.getOAuth(STAGING)?.issuer).toBe(STAGING);
	});

	it("puts a refreshed sign-in back where it came from, without changing the active deployment", async () => {
		await isolatedConfigHome();
		const config = await import("../src/lib/config.js");
		config.saveOAuth(sessionFor(PRODUCTION, "fat_production"), {
			baseUrl: PRODUCTION,
		});
		config.saveOAuth(sessionFor(STAGING, "fat_staging"), {
			baseUrl: STAGING,
		});

		config.saveOAuth(sessionFor(PRODUCTION, "fat_renewed"), {
			origin: PRODUCTION,
		});

		expect(config.getOAuth(PRODUCTION)?.accessToken).toBe("fat_renewed");
		expect(config.getOAuth(STAGING)?.accessToken).toBe("fat_staging");
		expect(config.getActiveOrigin()).toBe(STAGING);
	});

	it("answers an environment key for every deployment, and a stored one only for its own", async () => {
		await isolatedConfigHome();
		const config = await import("../src/lib/config.js");
		config.saveApiKey("fab_staging", { baseUrl: STAGING });

		expect(config.getApiKey(STAGING)).toBe("fab_staging");
		expect(config.getApiKey(PRODUCTION)).toBeUndefined();

		process.env.FABRIC_API_KEY = "fab_env";

		expect(config.getApiKey(PRODUCTION)).toBe("fab_env");
	});

	it("clears only the active deployment's credential on logout", async () => {
		await isolatedConfigHome();
		const config = await import("../src/lib/config.js");
		config.saveApiKey("fab_production", { baseUrl: PRODUCTION });
		config.saveApiKey("fab_staging", { baseUrl: STAGING });

		config.clearApiKey();

		expect(config.getApiKey(STAGING)).toBeUndefined();
		expect(config.getApiKey(PRODUCTION)).toBe("fab_production");
		expect(config.getBaseUrl()).toBe(STAGING);
	});
});
