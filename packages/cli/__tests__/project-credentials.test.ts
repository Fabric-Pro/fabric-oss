/**
 * A browser sign-in for one project is kept beside the deployment's own
 * credential, never in place of it, and is what a command for that project is
 * signed with first.
 *
 * The configuration is the real one, in a folder of its own, so what is asserted
 * is what a later run of the CLI would find on disk. Only the network is a
 * stand-in.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalAppData = process.env.APPDATA;

const ORIGIN = "https://deploy.example.com";
const OTHER_ORIGIN = "https://other.example.com";
const PROJECT = "project-example-one";
const OTHER_PROJECT = "project-example-two";

function session(label: string, origin = ORIGIN) {
	return {
		issuer: origin,
		clientId: `client-${label}`,
		redirectUri: "http://127.0.0.1:49152/callback",
		tokenEndpoint: `${origin}/api/auth/oauth2/token`,
		accessToken: `fat_${label}`,
		refreshToken: `frt_${label}`,
		expiresAt: 1_900_000_000_000,
	};
}

async function freshModules() {
	const home = await mkdtemp(path.join(tmpdir(), "fabric-project-creds-"));
	process.env.XDG_CONFIG_HOME = home;
	process.env.APPDATA = home;
	vi.resetModules();
	const config = await import("../src/lib/config.js");
	return { config, file: config.getConfigPath() };
}

async function onDisk(file: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(file, "utf8"));
}

beforeEach(() => {
	delete process.env.FABRIC_API_KEY;
	delete process.env.FABRIC_BASE_URL;
});

afterEach(() => {
	for (const [name, value] of [
		["XDG_CONFIG_HOME", originalConfigHome],
		["APPDATA", originalAppData],
	] as const) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
	delete process.env.FABRIC_API_KEY;
	delete process.env.FABRIC_BASE_URL;
	vi.resetModules();
	vi.unstubAllGlobals();
});

describe("keeping a project's sign-in", () => {
	it("stores it under the deployment, by project, and finds it only for that project", async () => {
		const { config } = await freshModules();

		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		expect(config.getOAuth(ORIGIN, PROJECT)).toEqual(session("one"));
		expect(config.getOAuth(ORIGIN, OTHER_PROJECT)).toBeUndefined();
		expect(config.getOAuth(ORIGIN)).toBeUndefined();
		expect(config.getOAuth(OTHER_ORIGIN, PROJECT)).toBeUndefined();
	});

	it("leaves the deployment's own key alone, and its key leaves the project's sign-in alone", async () => {
		const { config } = await freshModules();
		config.saveApiKey("fab_key", { baseUrl: ORIGIN });

		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		expect(config.hasStoredApiKey(ORIGIN)).toBe(true);
		expect(config.getApiKey(ORIGIN)).toBe("fab_key");

		config.saveApiKey("fab_replacement", { origin: ORIGIN });

		expect(config.getOAuth(ORIGIN, PROJECT)).toEqual(session("one"));
	});

	it("leaves the deployment's own sign-in alone, and its sign-in leaves the project's alone", async () => {
		const { config } = await freshModules();
		config.saveOAuth(session("organization"), {
			baseUrl: ORIGIN,
		});

		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});
		config.saveOAuth(session("organization-again"), { origin: ORIGIN });

		expect(config.getOAuth(ORIGIN)).toEqual(session("organization-again"));
		expect(config.getOAuth(ORIGIN, PROJECT)).toEqual(session("one"));
	});

	it("keeps each project's sign-in apart, and replaces only that project's", async () => {
		const { config } = await freshModules();

		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});
		config.saveOAuth(session("two"), {
			origin: ORIGIN,
			projectId: OTHER_PROJECT,
		});
		config.saveOAuth(session("one-renewed"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		expect(config.getOAuth(ORIGIN, PROJECT)).toEqual(
			session("one-renewed"),
		);
		expect(config.getOAuth(ORIGIN, OTHER_PROJECT)).toEqual(session("two"));
		expect(
			config.listProjectSignIns(ORIGIN).map((entry) => entry.projectId),
		).toEqual([PROJECT, OTHER_PROJECT]);
	});

	it("keeps a deployment's project sign-ins to that deployment", async () => {
		const { config } = await freshModules();

		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});
		config.saveOAuth(session("elsewhere", OTHER_ORIGIN), {
			origin: OTHER_ORIGIN,
			projectId: PROJECT,
		});

		expect(config.getOAuth(ORIGIN, PROJECT)?.accessToken).toBe("fat_one");
		expect(config.getOAuth(OTHER_ORIGIN, PROJECT)?.accessToken).toBe(
			"fat_elsewhere",
		);
	});

	it("treats a project id as a key and never as a property of the configuration", async () => {
		const { config } = await freshModules();

		config.saveOAuth(session("odd"), {
			origin: ORIGIN,
			projectId: "__proto__",
		});

		expect(config.getOAuth(ORIGIN, "__proto__")).toEqual(session("odd"));
		expect(config.getOAuth(ORIGIN, "constructor")).toBeUndefined();
		expect(config.getOAuth(ORIGIN, "toString")).toBeUndefined();
		expect(({} as Record<string, unknown>).accessToken).toBeUndefined();
	});
});

describe("signing a project out", () => {
	it("removes that project's sign-in and nothing else, and drops the map once it is empty", async () => {
		const { config, file } = await freshModules();
		config.saveApiKey("fab_key", { baseUrl: ORIGIN });
		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});
		config.saveOAuth(session("two"), {
			origin: ORIGIN,
			projectId: OTHER_PROJECT,
		});

		config.clearProjectSignIn(PROJECT, ORIGIN);

		expect(config.getOAuth(ORIGIN, PROJECT)).toBeUndefined();
		expect(config.getOAuth(ORIGIN, OTHER_PROJECT)).toEqual(session("two"));
		expect(config.getApiKey(ORIGIN)).toBe("fab_key");

		config.clearProjectSignIn(OTHER_PROJECT, ORIGIN);

		const stored = await onDisk(file);
		const profile = (stored.profiles as Record<string, object>)[ORIGIN];
		expect(profile).not.toHaveProperty("projects");
		expect(profile).toMatchObject({ apiKey: "fab_key" });
	});

	it("is a no-op for a project that has no sign-in", async () => {
		const { config } = await freshModules();
		config.saveApiKey("fab_key", { baseUrl: ORIGIN });

		config.clearProjectSignIn(PROJECT, ORIGIN);

		expect(config.getApiKey(ORIGIN)).toBe("fab_key");
	});

	it("is not what signing out of the deployment does", async () => {
		const { config } = await freshModules();
		config.saveOAuth(session("organization"), { baseUrl: ORIGIN });
		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		config.clearApiKey(ORIGIN);

		expect(config.getOAuth(ORIGIN)).toBeUndefined();
		expect(config.getOAuth(ORIGIN, PROJECT)).toEqual(session("one"));
	});
});

describe("which credential a command for a project is signed with", () => {
	it("is the project's own sign-in before the deployment's key or sign-in", async () => {
		const { config } = await freshModules();
		config.saveOAuth(session("organization"), { baseUrl: ORIGIN });
		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		expect(config.getApiKey(ORIGIN, PROJECT)).toBe("fat_one");
		expect(config.getApiKey(ORIGIN, OTHER_PROJECT)).toBe(
			"fat_organization",
		);
	});

	it("is the deployment's key when the project has no sign-in", async () => {
		const { config } = await freshModules();
		config.saveApiKey("fab_key", { baseUrl: ORIGIN });

		expect(config.getApiKey(ORIGIN, PROJECT)).toBe("fab_key");
	});

	it("is the project's sign-in over a stored key", async () => {
		const { config } = await freshModules();
		config.saveApiKey("fab_key", { baseUrl: ORIGIN });
		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		expect(config.getApiKey(ORIGIN, PROJECT)).toBe("fat_one");
	});

	it("is FABRIC_API_KEY above everything, as it has always been", async () => {
		const { config } = await freshModules();
		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});
		process.env.FABRIC_API_KEY = "fab_env";

		expect(config.getApiKey(ORIGIN, PROJECT)).toBe("fab_env");
		expect(config.getApiKey(ORIGIN)).toBe("fab_env");
	});

	it("never uses a project's sign-in for a command that names no project", async () => {
		const { config } = await freshModules();
		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		expect(config.getApiKey(ORIGIN)).toBeUndefined();
		expect(config.getApiKey(ORIGIN, OTHER_PROJECT)).toBeUndefined();
	});
});

describe("a command's client", () => {
	async function clientFor(): Promise<{
		config: Awaited<ReturnType<typeof freshModules>>["config"];
		getClient: typeof import("../src/lib/client.js").getClient;
		requests: Array<{ url: string; authorization: string | null }>;
	}> {
		const { config } = await freshModules();
		const { getClient } = await import("../src/lib/client.js");
		const requests: Array<{ url: string; authorization: string | null }> =
			[];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({
					url: String(input),
					authorization: new Headers(init?.headers).get(
						"authorization",
					),
				});
				return new Response(
					JSON.stringify({
						data: {
							user: { name: "Dev", email: "dev@example.com" },
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}),
		);
		return { config, getClient, requests };
	}

	it("signs a command for the project with the project's sign-in", async () => {
		const { config, getClient, requests } = await clientFor();
		config.saveOAuth(session("organization"), { baseUrl: ORIGIN });
		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		await getClient({ baseUrl: ORIGIN, project: PROJECT }).auth.whoami();

		expect(requests[0]?.authorization).toBe("Bearer fat_one");
	});

	it("signs a command that names no project with the deployment's, even when a project has one", async () => {
		const { config, getClient, requests } = await clientFor();
		config.saveOAuth(session("organization"), { baseUrl: ORIGIN });
		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		await getClient({ baseUrl: ORIGIN }).auth.whoami();

		expect(requests[0]?.authorization).toBe("Bearer fat_organization");
	});

	it("falls back to the deployment's credential for a project with no sign-in of its own", async () => {
		const { config, getClient, requests } = await clientFor();
		config.saveApiKey("fab_key", { baseUrl: ORIGIN });

		await getClient({ baseUrl: ORIGIN, project: PROJECT }).auth.whoami();

		expect(requests[0]?.authorization).toBe("Bearer fab_key");
	});

	it("stops, naming the project's sign-in, when the project has none and the deployment has no credential", async () => {
		const { config, getClient, requests } = await clientFor();
		config.saveOAuth(session("two"), {
			origin: ORIGIN,
			projectId: OTHER_PROJECT,
		});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as never);
		const written: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(((
			chunk: unknown,
		) => {
			written.push(String(chunk));
			return true;
		}) as never);

		expect(() => getClient({ baseUrl: ORIGIN, project: PROJECT })).toThrow(
			"exit 3",
		);

		expect(written.join("")).toContain(`auth login --project ${PROJECT}`);
		expect(requests).toEqual([]);
	});

	it("renews a project's sign-in into that project's entry, and no other", async () => {
		const { config } = await clientFor();
		const { createOAuthFetch } = await import(
			"../src/lib/oauth/session.js"
		);
		config.saveOAuth(session("organization"), { baseUrl: ORIGIN });
		config.saveOAuth(
			{ ...session("one"), expiresAt: 1_000 },
			{ origin: ORIGIN, projectId: PROJECT },
		);
		const tokenRequests: string[] = [];
		const answer = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) => {
				tokenRequests.push(String(init?.body));
				return new Response(
					JSON.stringify({
						access_token: "fat_one_renewed",
						refresh_token: "frt_one_renewed",
						expires_in: 3600,
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			},
		);
		const apiFetch = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) =>
				new Response(
					JSON.stringify({
						authorization: new Headers(init?.headers).get(
							"authorization",
						),
					}),
					{ status: 200 },
				),
		);

		const signed = createOAuthFetch(
			{
				origin: ORIGIN,
				projectId: PROJECT,
				fetch: answer as unknown as typeof fetch,
				now: () => 2_000,
			},
			apiFetch as unknown as typeof fetch,
		);
		await signed(`${ORIGIN}/api/v1/auth/whoami`);

		expect(tokenRequests[0]).toContain("refresh_token=frt_one");
		expect(apiFetch).toHaveBeenCalledOnce();
		expect(config.getOAuth(ORIGIN, PROJECT)?.accessToken).toBe(
			"fat_one_renewed",
		);
		expect(config.getOAuth(ORIGIN)?.accessToken).toBe("fat_organization");
	});

	it("names the project's sign-in when it has expired", async () => {
		const { config } = await clientFor();
		const { createOAuthFetch, OAuthSessionExpiredError } = await import(
			"../src/lib/oauth/session.js"
		);
		config.saveOAuth(session("organization"), { baseUrl: ORIGIN });

		const signed = createOAuthFetch({ origin: ORIGIN, projectId: PROJECT });

		await expect(signed(`${ORIGIN}/api/v1/auth/whoami`)).rejects.toThrow(
			OAuthSessionExpiredError,
		);
		await expect(signed(`${ORIGIN}/api/v1/auth/whoami`)).rejects.toThrow(
			`auth login --project ${PROJECT}`,
		);
	});
});

describe("the configuration file", () => {
	it("keeps version 2 and reads a file that has no project sign-ins exactly as before", async () => {
		const { config, file } = await freshModules();
		await writeFile(
			file,
			JSON.stringify({
				version: 2,
				activeProfile: ORIGIN,
				profiles: { [ORIGIN]: { apiKey: "fab_key", baseUrl: ORIGIN } },
				defaultFormat: "table",
			}),
		);
		vi.resetModules();
		const reread = await import("../src/lib/config.js");

		expect(reread.getApiKey(ORIGIN)).toBe("fab_key");
		expect(reread.listProjectSignIns(ORIGIN)).toEqual([]);

		reread.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		const stored = await onDisk(file);
		expect(stored.version).toBe(2);
		expect(stored.profiles).toEqual({
			[ORIGIN]: {
				apiKey: "fab_key",
				baseUrl: ORIGIN,
				projects: { [PROJECT]: { oauth: session("one") } },
			},
		});
		expect(config).toBeDefined();
	});

	it("keeps every field a build that wrote it knew and this one does not, through a save", async () => {
		const { file } = await freshModules();
		await writeFile(
			file,
			JSON.stringify({
				version: 2,
				activeProfile: ORIGIN,
				profiles: {
					[ORIGIN]: {
						apiKey: "fab_key",
						baseUrl: ORIGIN,
						futureField: { kept: true },
					},
					[OTHER_ORIGIN]: { oauth: session("other", OTHER_ORIGIN) },
				},
				defaultFormat: "json",
			}),
		);
		vi.resetModules();
		const reread = await import("../src/lib/config.js");

		reread.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		const stored = (await onDisk(file)) as {
			profiles: Record<string, Record<string, unknown>>;
			defaultFormat: string;
		};
		expect(stored.profiles[ORIGIN]).toMatchObject({
			futureField: { kept: true },
			apiKey: "fab_key",
		});
		expect(stored.profiles[OTHER_ORIGIN]).toEqual({
			oauth: session("other", OTHER_ORIGIN),
		});
		expect(stored.defaultFormat).toBe("json");
	});

	it("still reads a version 1 file, and saves a project sign-in into the profile it became", async () => {
		const { file } = await freshModules();
		await writeFile(
			file,
			JSON.stringify({
				activeProfile: "work",
				profiles: { work: { baseUrl: ORIGIN, apiKey: "fab_work" } },
				defaultFormat: "table",
			}),
		);
		vi.resetModules();
		const reread = await import("../src/lib/config.js");
		expect(reread.getApiKey(ORIGIN)).toBe("fab_work");

		reread.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		const stored = await onDisk(file);
		expect(stored.version).toBe(2);
		expect(
			(stored.profiles as Record<string, Record<string, unknown>>)[
				ORIGIN
			],
		).toMatchObject({
			apiKey: "fab_work",
			projects: { [PROJECT]: { oauth: session("one") } },
		});
	});

	it("takes the client registration from the project's own sign-in, then the deployment's, then any project's", async () => {
		const { config } = await freshModules();
		config.saveOAuth(session("two"), {
			origin: ORIGIN,
			projectId: OTHER_PROJECT,
		});

		expect(config.getRegisteredClient(ORIGIN, PROJECT)?.clientId).toBe(
			"client-two",
		);

		config.saveOAuth(session("organization"), { origin: ORIGIN });

		expect(config.getRegisteredClient(ORIGIN, PROJECT)?.clientId).toBe(
			"client-organization",
		);

		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		expect(config.getRegisteredClient(ORIGIN, PROJECT)?.clientId).toBe(
			"client-one",
		);
		expect(
			config.getRegisteredClient(OTHER_ORIGIN, PROJECT),
		).toBeUndefined();
	});
});
