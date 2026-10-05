/**
 * `fabric auth logout --project <id>` ends one project's sign-in and no other
 * credential. The configuration is the real one, in a folder of its own, so
 * what is asserted is what a later run would find on disk; only the server
 * (the revocation) and the terminal are stand-ins.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

const { mocks } = vi.hoisted(() => ({
	mocks: {
		revokeOAuthSession: vi.fn<(oauth: unknown) => Promise<boolean>>(),
		printError: vi.fn((_: string, code?: number) => {
			throw new ExitSignal(code ?? 1);
		}),
		printSuccess: vi.fn(),
		printWarning: vi.fn(),
	},
}));

vi.mock("../src/lib/oauth/session.js", () => ({
	revokeOAuthSession: mocks.revokeOAuthSession,
}));

vi.mock("../src/lib/output.js", () => ({
	printError: mocks.printError,
	printSuccess: mocks.printSuccess,
	printWarning: mocks.printWarning,
}));

const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalAppData = process.env.APPDATA;

const ORIGIN = "https://deploy.example.com";
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

async function setUp() {
	const home = await mkdtemp(path.join(tmpdir(), "fabric-logout-"));
	process.env.XDG_CONFIG_HOME = home;
	process.env.APPDATA = home;
	process.env.FABRIC_BASE_URL = ORIGIN;
	vi.resetModules();
	const config = await import("../src/lib/config.js");
	const { buildLogoutCommand } = await import(
		"../src/commands/auth/logout.js"
	);
	return {
		config,
		logout: (args: string[] = []) =>
			buildLogoutCommand().parseAsync(args, { from: "user" }),
	};
}

beforeEach(() => {
	delete process.env.FABRIC_API_KEY;
	mocks.revokeOAuthSession.mockReset();
	mocks.revokeOAuthSession.mockResolvedValue(true);
	mocks.printError.mockClear();
	mocks.printSuccess.mockReset();
	mocks.printWarning.mockReset();
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
	delete process.env.FABRIC_BASE_URL;
	vi.resetModules();
});

describe("fabric auth logout --project", () => {
	it("revokes and removes that project's sign-in, and leaves every other credential", async () => {
		const { config, logout } = await setUp();
		config.saveApiKey("fab_key", { baseUrl: ORIGIN });
		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});
		config.saveOAuth(session("two"), {
			origin: ORIGIN,
			projectId: OTHER_PROJECT,
		});

		await logout(["--project", PROJECT]);

		expect(mocks.revokeOAuthSession).toHaveBeenCalledTimes(1);
		expect(mocks.revokeOAuthSession).toHaveBeenCalledWith(session("one"));
		expect(config.getOAuth(ORIGIN, PROJECT)).toBeUndefined();
		expect(config.getOAuth(ORIGIN, OTHER_PROJECT)).toEqual(session("two"));
		expect(config.getApiKey(ORIGIN)).toBe("fab_key");
		expect(mocks.printSuccess).toHaveBeenCalledWith(
			`Signed out of project ${PROJECT}. Every other sign-in is untouched.`,
		);
		expect(mocks.printWarning).not.toHaveBeenCalled();
	});

	it("leaves the deployment's own browser sign-in", async () => {
		const { config, logout } = await setUp();
		config.saveOAuth(session("organization"), { baseUrl: ORIGIN });
		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		await logout(["--project", PROJECT]);

		expect(mocks.revokeOAuthSession).toHaveBeenCalledWith(session("one"));
		expect(config.getOAuth(ORIGIN)).toEqual(session("organization"));
	});

	it("removes the sign-in from this machine and says how to revoke it when the server cannot be reached", async () => {
		const { config, logout } = await setUp();
		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});
		mocks.revokeOAuthSession.mockResolvedValue(false);

		await logout(["--project", PROJECT]);

		expect(config.getOAuth(ORIGIN, PROJECT)).toBeUndefined();
		expect(mocks.printWarning).toHaveBeenCalledWith(
			expect.stringContaining("Connected agents"),
		);
	});

	it("says there is nothing to sign out of for a project that has no sign-in, and touches nothing", async () => {
		const { config, logout } = await setUp();
		config.saveOAuth(session("two"), {
			origin: ORIGIN,
			projectId: OTHER_PROJECT,
		});

		await logout(["--project", PROJECT]);

		expect(mocks.revokeOAuthSession).not.toHaveBeenCalled();
		expect(mocks.printWarning).toHaveBeenCalledWith(
			`No sign-in stored for project ${PROJECT} on ${ORIGIN}.`,
		);
		expect(config.getOAuth(ORIGIN, OTHER_PROJECT)).toEqual(session("two"));
	});

	it.each([
		["a space", "my project"],
		["a path", "../other"],
		["more than 64 characters", "a".repeat(65)],
	])("refuses an id with %s in it", async (_label, id) => {
		const { config, logout } = await setUp();
		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		await expect(logout(["--project", id])).rejects.toMatchObject({
			code: 2,
		});

		expect(mocks.revokeOAuthSession).not.toHaveBeenCalled();
		expect(config.getOAuth(ORIGIN, PROJECT)).toEqual(session("one"));
	});
});

describe("fabric auth logout, with project sign-ins stored", () => {
	it("removes the deployment's own sign-in and says which project sign-ins are left, and how to end one", async () => {
		const { config, logout } = await setUp();
		config.saveOAuth(session("organization"), { baseUrl: ORIGIN });
		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});

		await logout();

		expect(mocks.revokeOAuthSession).toHaveBeenCalledTimes(1);
		expect(mocks.revokeOAuthSession).toHaveBeenCalledWith(
			session("organization"),
		);
		expect(config.getOAuth(ORIGIN)).toBeUndefined();
		expect(config.getOAuth(ORIGIN, PROJECT)).toEqual(session("one"));
		expect(mocks.printSuccess).toHaveBeenCalledWith(
			"Logged out. Sign-in removed.",
		);
		expect(mocks.printWarning).toHaveBeenCalledWith(
			expect.stringContaining(`Still signed in for project ${PROJECT}.`),
		);
		expect(mocks.printWarning).toHaveBeenCalledWith(
			expect.stringContaining(`auth logout --project ${PROJECT}`),
		);
	});

	it("says the deployment itself has nothing stored, and names the project sign-ins, when only those are", async () => {
		const { config, logout } = await setUp();
		config.saveOAuth(session("one"), {
			origin: ORIGIN,
			projectId: PROJECT,
		});
		config.saveOAuth(session("two"), {
			origin: ORIGIN,
			projectId: OTHER_PROJECT,
		});

		await logout();

		expect(mocks.revokeOAuthSession).not.toHaveBeenCalled();
		expect(mocks.printWarning).toHaveBeenCalledWith(
			expect.stringContaining(
				`Nothing stored for the deployment itself. Still signed in for projects ${PROJECT}, ${OTHER_PROJECT}.`,
			),
		);
		expect(config.getOAuth(ORIGIN, PROJECT)).toEqual(session("one"));
	});

	it("says it is already logged out when nothing at all is stored", async () => {
		const { logout } = await setUp();

		await logout();

		expect(mocks.printWarning).toHaveBeenCalledWith(
			"No credentials stored — already logged out.",
		);
	});
});

describe("fabric auth logout --base-url", () => {
	const OTHER = "https://other.example.com";

	/** Two deployments, each with its own sign-in and a project's of its own, ORIGIN the one in use. */
	async function twoDeployments() {
		const set = await setUp();
		const { config } = set;
		config.saveOAuth(session("here"), { baseUrl: ORIGIN });
		config.saveOAuth(session("here-project", ORIGIN), {
			origin: ORIGIN,
			projectId: PROJECT,
		});
		config.saveOAuth(session("there", OTHER), { origin: OTHER });
		config.saveOAuth(session("there-project", OTHER), {
			origin: OTHER,
			projectId: PROJECT,
		});
		config.saveOAuth(session("there-other-project", OTHER), {
			origin: OTHER,
			projectId: OTHER_PROJECT,
		});
		return set;
	}

	it("signs out of the deployment it names and leaves the one in use alone", async () => {
		const { config, logout } = await twoDeployments();

		await logout(["--base-url", OTHER]);

		expect(mocks.revokeOAuthSession).toHaveBeenCalledOnce();
		expect(mocks.revokeOAuthSession).toHaveBeenCalledWith(
			session("there", OTHER),
		);
		expect(config.getOAuth(OTHER)).toBeUndefined();
		expect(config.getOAuth(ORIGIN)).toEqual(session("here"));
		expect(mocks.printSuccess).toHaveBeenCalledWith(
			"Logged out. Sign-in removed.",
		);
	});

	it("takes the deployment's own key too, and only that deployment's", async () => {
		const { config, logout } = await setUp();
		config.saveApiKey("fab_here", { baseUrl: ORIGIN });
		config.saveApiKey("fab_there", { origin: OTHER });

		await logout(["--base-url", OTHER]);

		expect(config.hasStoredApiKey(OTHER)).toBe(false);
		expect(config.getApiKey(ORIGIN)).toBe("fab_here");
		expect(mocks.printSuccess).toHaveBeenCalledWith(
			"Logged out. API key removed.",
		);
	});

	it("signs out of one project on the deployment it names, and of no other project or deployment", async () => {
		const { config, logout } = await twoDeployments();

		await logout(["--project", PROJECT, "--base-url", OTHER]);

		expect(mocks.revokeOAuthSession).toHaveBeenCalledOnce();
		expect(mocks.revokeOAuthSession).toHaveBeenCalledWith(
			session("there-project", OTHER),
		);
		expect(config.getOAuth(OTHER, PROJECT)).toBeUndefined();
		expect(config.getOAuth(OTHER, OTHER_PROJECT)).toEqual(
			session("there-other-project", OTHER),
		);
		expect(config.getOAuth(OTHER)).toEqual(session("there", OTHER));
		expect(config.getOAuth(ORIGIN, PROJECT)).toEqual(
			session("here-project", ORIGIN),
		);
		expect(config.getOAuth(ORIGIN)).toEqual(session("here"));
		expect(mocks.printSuccess).toHaveBeenCalledWith(
			`Signed out of project ${PROJECT}. Every other sign-in is untouched.`,
		);
	});

	it("is the deployment it names even when the environment names another", async () => {
		const { config, logout } = await twoDeployments();
		process.env.FABRIC_BASE_URL = ORIGIN;

		await logout(["--project", PROJECT, "--base-url", OTHER]);

		expect(config.getOAuth(OTHER, PROJECT)).toBeUndefined();
		expect(config.getOAuth(ORIGIN, PROJECT)).toEqual(
			session("here-project", ORIGIN),
		);
	});

	it("reads the address as an origin, as whoami does", async () => {
		const { config, logout } = await twoDeployments();

		await logout(["--base-url", "https://Other.Example.com/app/?x=1"]);

		expect(config.getOAuth(OTHER)).toBeUndefined();
		expect(config.getOAuth(ORIGIN)).toEqual(session("here"));
	});

	it("says there is nothing to sign out of on that deployment, and touches nothing, when it has no sign-in", async () => {
		const { config, logout } = await setUp();
		config.saveOAuth(session("here"), { baseUrl: ORIGIN });

		await logout(["--base-url", OTHER]);

		expect(mocks.revokeOAuthSession).not.toHaveBeenCalled();
		expect(mocks.printWarning).toHaveBeenCalledWith(
			`No credentials stored for ${OTHER} — already logged out.`,
		);
		expect(config.getOAuth(ORIGIN)).toEqual(session("here"));
	});

	it("says there is no sign-in for the project on that deployment, and touches nothing, when only the other deployment has one", async () => {
		const { config, logout } = await twoDeployments();
		config.clearProjectSignIn(PROJECT, OTHER);

		await logout(["--project", PROJECT, "--base-url", OTHER]);

		expect(mocks.revokeOAuthSession).not.toHaveBeenCalled();
		expect(mocks.printWarning).toHaveBeenCalledWith(
			`No sign-in stored for project ${PROJECT} on ${OTHER}.`,
		);
		expect(config.getOAuth(ORIGIN, PROJECT)).toEqual(
			session("here-project", ORIGIN),
		);
	});

	it.each([
		["not a URL", "not a url"],
		["a scheme that is not http", "ftp://other.example.com"],
	])(
		"refuses an address that is %s, before it touches anything",
		async (_label, address) => {
			const { config, logout } = await twoDeployments();

			await expect(
				logout(["--project", PROJECT, "--base-url", address]),
			).rejects.toMatchObject({ code: 2 });
			await expect(logout(["--base-url", address])).rejects.toMatchObject(
				{
					code: 2,
				},
			);

			expect(mocks.revokeOAuthSession).not.toHaveBeenCalled();
			expect(config.getOAuth(ORIGIN)).toEqual(session("here"));
			expect(config.getOAuth(OTHER)).toEqual(session("there", OTHER));
		},
	);

	it("leaves the project sign-ins of that deployment, and gives a line that works for a deployment that is not the default", async () => {
		const { config, logout } = await twoDeployments();

		await logout(["--base-url", OTHER]);

		const hint = mocks.printWarning.mock.calls
			.map(([line]) => String(line))
			.find((line) => line.startsWith("Still signed in for projects"));
		expect(hint).toContain(
			`Still signed in for projects ${PROJECT}, ${OTHER_PROJECT}.`,
		);
		expect(hint).toContain(
			`auth logout --project ${PROJECT} --base-url ${OTHER}`,
		);

		// The line it gave is one the command accepts, and signs that project out there.
		const given = (hint ?? "").slice(
			(hint ?? "").indexOf("auth logout ") + "auth logout ".length,
		);
		mocks.revokeOAuthSession.mockClear();
		await logout(given.split(" "));

		expect(mocks.revokeOAuthSession).toHaveBeenCalledWith(
			session("there-project", OTHER),
		);
		expect(config.getOAuth(OTHER, PROJECT)).toBeUndefined();
		expect(config.getOAuth(OTHER, OTHER_PROJECT)).toEqual(
			session("there-other-project", OTHER),
		);
	});
});
