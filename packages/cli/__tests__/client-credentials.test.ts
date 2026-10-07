/**
 * The client every command builds (Fizzy #2878): it introduces itself with a
 * `User-Agent`, takes the credential stored for the deployment it talks to
 * and no other, and keeps the upgrade line a deployment asks it to show.
 *
 * `getClient` runs for real; only the stored configuration is stood in for,
 * and `fetch` is the global one, stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClient } from "../src/lib/client.js";
import {
	cliUserAgent,
	recordUpgradeNotice,
	takeUpgradeNotice,
} from "../src/lib/user-agent.js";

const PRODUCTION = "https://fabric.pro";
const STAGING = "https://staging.example";

/** Text built from code points, so the source holds no invisible character. */
const chars = (...codes: number[]): string => String.fromCodePoint(...codes);

/** C1 controls, the line separators, and what reorders text. */
function isHidden(code: number): boolean {
	return (
		(code >= 0x80 && code <= 0x9f) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x61c ||
		code === 0x200e ||
		code === 0x200f ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2066 && code <= 0x2069)
	);
}

const { store } = vi.hoisted(() => ({
	store: {
		keys: new Map<string, string>(),
		sessions: new Map<
			string,
			{
				issuer: string;
				accessToken: string;
				expiresAt: number;
				refreshToken?: string;
			}
		>(),
		baseUrl: undefined as string | undefined,
		/** Every time a credential was looked up, by the origin it was asked for. */
		reads: [] as Array<string | undefined>,
	},
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: (origin?: string) => {
		store.reads.push(origin);
		return (
			process.env.FABRIC_API_KEY ??
			(origin === undefined
				? undefined
				: (store.keys.get(origin) ??
					store.sessions.get(origin)?.accessToken))
		);
	},
	hasStoredApiKey: (origin?: string) => {
		store.reads.push(origin);
		return (
			Boolean(process.env.FABRIC_API_KEY) ||
			(origin !== undefined && store.keys.has(origin))
		);
	},
	getOAuth: (origin?: string) => {
		store.reads.push(origin);
		return origin === undefined ? undefined : store.sessions.get(origin);
	},
	getBaseUrl: () => store.baseUrl,
	getConfigPath: () => "/tmp/example-config.json",
	saveOAuth: () => undefined,
}));

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

let requests: Array<{ url: string; headers: Headers }>;
let answerHeaders: Record<string, string>;

beforeEach(() => {
	store.keys.clear();
	store.sessions.clear();
	store.baseUrl = undefined;
	store.reads.length = 0;
	delete process.env.FABRIC_API_KEY;
	takeUpgradeNotice();
	requests = [];
	answerHeaders = {};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({
				url: String(input),
				headers: new Headers(init?.headers),
			});
			return new Response(
				JSON.stringify({
					data: { user: { name: "Dev", email: "dev@example.com" } },
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
						...answerHeaders,
					},
				},
			);
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	delete process.env.FABRIC_API_KEY;
});

describe("cliUserAgent", () => {
	it("names the build, Node and the platform", () => {
		expect(cliUserAgent("0.5.0", "22.11.0", "linux")).toBe(
			"fabric-cli/0.5.0 (node/22.11.0; linux; instructions-stream-v1; instructions-repository-direct-v1)",
		);
	});

	it("defaults to this package's version and this machine", () => {
		expect(cliUserAgent()).toMatch(
			new RegExp(
				`^fabric-cli/\\d+\\.\\d+\\.\\d+\\S* \\(node/${process.versions.node.replace(/\./g, "\\.")}; ${process.platform}; instructions-stream-v1; instructions-repository-direct-v1\\)$`,
			),
		);
	});
});

describe("getClient", () => {
	it("sends the User-Agent on every request", async () => {
		store.keys.set(PRODUCTION, "fab_production");

		await getClient().auth.whoami();

		expect(requests[0]?.headers.get("user-agent")).toBe(cliUserAgent());
	});

	it("uses the key stored for the deployment's origin, and talks to that deployment", async () => {
		store.keys.set(PRODUCTION, "fab_production");
		store.keys.set(STAGING, "fab_staging");

		await getClient({ baseUrl: STAGING }).auth.whoami();

		expect(requests[0]?.url).toBe(`${STAGING}/api/v1/auth/whoami`);
		expect(requests[0]?.headers.get("authorization")).toBe(
			"Bearer fab_staging",
		);
	});

	it("takes the deployment from FABRIC_BASE_URL or the profile when none is given", async () => {
		store.keys.set(STAGING, "fab_staging");
		store.baseUrl = STAGING;

		await getClient().auth.whoami();

		expect(requests[0]?.url).toBe(`${STAGING}/api/v1/auth/whoami`);
		expect(requests[0]?.headers.get("authorization")).toBe(
			"Bearer fab_staging",
		);
	});

	it("never sends another deployment's key: with none stored for this one it stops and says to sign in", async () => {
		store.keys.set(PRODUCTION, "fab_production");
		const exit = vi.spyOn(process, "exit").mockImplementation(((
			code?: number,
		) => {
			throw new ExitSignal(code ?? 0);
		}) as never);
		const written: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(((
			chunk: unknown,
		) => {
			written.push(String(chunk));
			return true;
		}) as never);

		expect(() => getClient({ baseUrl: STAGING })).toThrow(ExitSignal);

		expect(exit).toHaveBeenCalledWith(3);
		expect(requests).toEqual([]);
	});

	it.each([
		[
			"FABRIC_BASE_URL or the profile names an address that is not a URL",
			"http://",
		],
		["it names something with no scheme", "deploy.example.com"],
		["it names another scheme", "ftp://deploy.example.com"],
	])(
		"stops with the bad-address line when %s, and loads no key",
		async (_label, address) => {
			store.keys.set(PRODUCTION, "fab_production");
			store.baseUrl = address;
			const exit = vi.spyOn(process, "exit").mockImplementation(((
				code?: number,
			) => {
				throw new ExitSignal(code ?? 0);
			}) as never);
			const written: string[] = [];
			vi.spyOn(process.stderr, "write").mockImplementation(((
				chunk: unknown,
			) => {
				written.push(String(chunk));
				return true;
			}) as never);

			expect(() => getClient()).toThrow(ExitSignal);

			expect(exit).toHaveBeenCalledWith(2);
			expect(written.join("")).toBe(
				"✗ The deployment address is not a URL. Use --base-url https://example.com\n",
			);
			expect(store.reads).toEqual([]);
			expect(requests).toEqual([]);
		},
	);

	it("stops the same way when --base-url is the bad address", async () => {
		store.keys.set(PRODUCTION, "fab_production");
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ExitSignal(code ?? 0);
		}) as never);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		expect(() => getClient({ baseUrl: "http://" })).toThrow(ExitSignal);

		expect(store.reads).toEqual([]);
		expect(requests).toEqual([]);
	});

	it("signs requests with the browser sign-in stored for the deployment", async () => {
		store.sessions.set(STAGING, {
			issuer: STAGING,
			accessToken: "fat_staging",
			expiresAt: Date.now() + 3_600_000,
		});

		await getClient({ baseUrl: STAGING }).auth.whoami();

		expect(requests[0]?.headers.get("authorization")).toBe(
			"Bearer fat_staging",
		);
	});

	it("refuses to send a browser sign-in to a deployment that did not issue it", async () => {
		store.sessions.set(STAGING, {
			issuer: "https://elsewhere.example",
			accessToken: "fat_staging",
			expiresAt: Date.now() + 3_600_000,
		});

		await expect(
			getClient({
				baseUrl: STAGING,
				retry: { maxRetries: 0 },
			}).auth.whoami(),
		).rejects.toMatchObject({ code: "NETWORK_ERROR" });

		expect(requests).toEqual([]);
	});
});

describe("the upgrade line", () => {
	it("keeps the first one a deployment sends", async () => {
		store.keys.set(PRODUCTION, "fab_production");
		answerHeaders = {
			"X-Fabric-Cli-Upgrade":
				"Run: npx -y https://fabric.pro/cli/fabric-0.6.0.tgz instructions init",
		};
		const client = getClient();

		await client.auth.whoami();
		answerHeaders = { "X-Fabric-Cli-Upgrade": "Something else" };
		await client.auth.whoami();

		expect(takeUpgradeNotice()).toBe(
			"Run: npx -y https://fabric.pro/cli/fabric-0.6.0.tgz instructions init",
		);
		expect(takeUpgradeNotice()).toBeNull();
	});

	it("records nothing when no response carries one", async () => {
		store.keys.set(PRODUCTION, "fab_production");

		await getClient().auth.whoami();

		expect(takeUpgradeNotice()).toBeNull();
	});

	it("shows control characters from a server as spaces and bounds the length", () => {
		recordUpgradeNotice(`Run:\u001b[2J\nupdate ${"x".repeat(1_000)}`);

		const line = takeUpgradeNotice() ?? "";
		expect(line.startsWith("Run: [2J update xxx")).toBe(true);
		expect(
			[...line].some(
				(character) =>
					character.charCodeAt(0) < 0x20 ||
					character.charCodeAt(0) === 0x7f,
			),
		).toBe(false);
		expect(line.length).toBeLessThanOrEqual(300);
	});

	it("shows the C1 controls, the line separators and the characters that reorder text as spaces", () => {
		const hostile = [
			"Run:",
			chars(0x9b),
			"red",
			chars(0x2028),
			"next",
			chars(0x2029),
			"more ",
			chars(0x202e),
			"evil",
			chars(0x202c),
			" ",
			chars(0x2066, 0x78, 0x2069),
			" ",
			chars(0x200e, 0x79, 0x200f),
			" ",
			chars(0x61c),
			"z",
		].join("");

		recordUpgradeNotice(hostile);

		const line = takeUpgradeNotice() ?? "";
		expect(line).toBe("Run: red next more  evil   x   y   z");
		for (const character of line) {
			expect(isHidden(character.codePointAt(0) ?? 0)).toBe(false);
		}
	});

	it("ignores an empty line", () => {
		recordUpgradeNotice("   ");

		expect(takeUpgradeNotice()).toBeNull();
	});

	it("ignores a line that is nothing but characters it takes out", () => {
		recordUpgradeNotice(chars(0x202e, 0x2066, 0x20, 0x9b));

		expect(takeUpgradeNotice()).toBeNull();
	});
});
