/** Real QA browser wiring with local network and deterministic model fixtures. */
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import {
	type PinnedFetchOptions,
	pinnedConnectLookup,
} from "@repo/utils/url-security";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV } from "../src/activities/browser-automation/url-guard";
import {
	type BrowserOperation,
	closeBrowser,
	openBrowser,
	performOperation,
	type RunnerBrowser,
	settleNavigation,
} from "../src/activities/qa-agentic-run/browser-driver";
import {
	type RunAgenticCaseInput,
	runAgenticCase,
} from "../src/activities/qa-agentic-run/run-case";

type Dispatcher = NonNullable<PinnedFetchOptions["dispatcher"]> & {
	close(): Promise<void>;
};
const transport = vi.hoisted(() => ({
	dispatcher: null as Dispatcher | null,
	relayed: [] as string[],
	decide: vi.fn(),
	stallRelay: false,
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: async () => ({ model: {}, metadata: null }),
}));
vi.mock("@repo/database", () => ({
	getBoundPromptForAgent: async () => ({
		version: { content: "Runner instructions" },
	}),
	recordRunEvidence: vi.fn(),
	resolveEnvironmentAuth: vi.fn(),
}));
vi.mock("@repo/storage", () => ({
	buildTenantStoragePath: vi.fn(),
	uploadFile: vi.fn(),
}));
vi.mock("../src/activities/qa-agentic-run/model-decision", () => ({
	decideWithModel: transport.decide,
	describeModelFailure: () => "Model failed",
}));
vi.mock("@repo/utils/url-security", async (original) => {
	const actual = await original<typeof import("@repo/utils/url-security")>();
	return {
		...actual,
		assertSafeOutboundUrlResolved: async () => {},
		safeFetchOutboundPinned: (
			url: string,
			init: RequestInit,
			options: PinnedFetchOptions,
		) => {
			transport.relayed.push(url);
			if (transport.stallRelay) {
				return new Promise<Response>(() => {});
			}
			if (!transport.dispatcher) {
				throw new Error("Fixture dispatcher missing");
			}
			return actual.safeFetchOutboundPinned(
				url.replace(/^https:/, "http:"),
				init,
				{
					...options,
					dispatcher: transport.dispatcher,
					lookup: async () => [
						{
							address:
								new URL(url).pathname === "/private"
									? "127.0.0.1"
									: "93.184.216.34",
							family: 4,
						},
					],
				},
			);
		},
	};
});
const SKIP = process.env.FABRIC_SKIP_BROWSER_E2E === "1";
const previousAllowed = process.env[BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV];
let server: Server;
let trap: Server;
let origin = "";
let trapOrigin = "";
let runner: RunnerBrowser | null = null;
const received: {
	path: string;
	method: string;
	cookie: string;
	authorization: string;
}[] = [];
let trapHits = 0;
async function listen(value: Server): Promise<number> {
	await new Promise<void>((resolve) => value.listen(0, "127.0.0.1", resolve));
	return (value.address() as AddressInfo).port;
}
beforeAll(async () => {
	if (SKIP) {
		return;
	}
	const require = createRequire(import.meta.url);
	const fromUtils = createRequire(
		require.resolve("@repo/utils/url-security"),
	);
	const { Agent } = fromUtils("undici") as {
		Agent: new (options: {
			connect: { lookup: ReturnType<typeof pinnedConnectLookup> };
		}) => Dispatcher;
	};
	transport.dispatcher = new Agent({
		connect: {
			lookup: pinnedConnectLookup({ address: "127.0.0.1", family: 4 }),
		},
	});
	trap = createServer((_req, res) => {
		trapHits++;
		res.end("internal data");
	});
	trapOrigin = `http://internal.localhost:${await listen(trap)}`;
	server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://fixture");
		received.push({
			path: url.pathname,
			method: req.method ?? "",
			cookie: req.headers.cookie ?? "",
			authorization: req.headers.authorization ?? "",
		});
		const redirect = (target: string, status = 302) => {
			res.writeHead(status, {
				location: target,
				"set-cookie": "hop=1; Path=/; HttpOnly; Secure",
			});
			res.end();
		};
		switch (url.pathname) {
			case "/click":
				res.writeHead(200, { "content-type": "text/html" });
				return res.end(
					"<button onclick=\"location.href='/cross?status=302'\">Continue</button>",
				);
			case "/same":
				return redirect(
					"/final",
					Number(url.searchParams.get("status")),
				);
			case "/cross":
				return redirect(
					trapOrigin +
						"/secret?code=fixture-secret#token=fixture-secret",
					Number(url.searchParams.get("status")),
				);
			case "/second":
				return redirect(
					`/cross?status=${url.searchParams.get("status")}`,
				);
			case "/rebind":
				return redirect("/private");
			case "/loop":
				return redirect("/loop");
			case "/post":
				return redirect(
					"/final",
					Number(url.searchParams.get("status")),
				);
			case "/asset":
				return redirect("/asset-final");
			case "/asset-cross":
				return redirect(`${trapOrigin}/secret`);
			case "/asset-final":
				res.writeHead(200, { "content-type": "text/plain" });
				return res.end("asset");
			case "/form":
				res.writeHead(200, { "content-type": "text/html" });
				return res.end(
					'<form action="/post?status=' +
						url.searchParams.get("status") +
						'" method="post"><input name="value" value="fixture"><button>Submit</button></form>',
				);
			default:
				res.writeHead(200, { "content-type": "text/html" });
				res.end("<title>Fixture</title><body>Final page</body>");
		}
	});
	origin = `https://a.example.com:${await listen(server)}`;
});
beforeEach(async () => {
	if (SKIP) {
		return;
	}
	received.length = 0;
	trapHits = 0;
	transport.relayed.length = 0;
	transport.decide.mockReset();
	transport.stallRelay = false;
	process.env[BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV] =
		"a.example.com,internal.localhost";
	runner = await openBrowser({
		browser: "chromium",
		resolution: "1280x720",
		timeoutMs: 5_000,
		targetOrigin: origin,
		scopedHTTPHeaders: {
			origin,
			headers: { Authorization: "Bearer fixture" },
		},
	});
});
afterEach(async () => {
	if (runner) {
		await closeBrowser(runner);
		runner = null;
	}
});
afterAll(async () => {
	server?.close();
	trap?.close();
	await transport.dispatcher?.close();
	if (previousAllowed === undefined) {
		delete process.env[BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV];
	} else {
		process.env[BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV] = previousAllowed;
	}
});
function current(): RunnerBrowser {
	if (!runner) {
		throw new Error("QA browser did not launch");
	}
	return runner;
}
function caseInput(path: string): RunAgenticCaseInput {
	return {
		projectId: "fixture-project",
		organizationId: null,
		userId: "fixture-user",
		testCaseId: "fixture-case",
		identifier: "TC-1",
		title: "Navigation",
		description: null,
		steps: [
			{
				order: 1,
				action: "Click Continue",
				expected: "Destination loaded",
			},
		],
		targetBaseUrl: origin + path,
		browser: "chromium",
		resolution: "1280x720",
		evidencePolicy: "NONE",
		houseRules: null,
	};
}
describe.skipIf(SKIP)("QA runner browser security (real Chromium)", () => {
	it("aborts an uncooperative relay before Playwright's navigation timeout", async () => {
		await closeBrowser(current());
		runner = await openBrowser({
			browser: "chromium",
			resolution: "1280x720",
			timeoutMs: 3_000,
			targetOrigin: origin,
		});
		transport.stallRelay = true;

		await expect(
			current().page.goto(`${origin}/final`, {
				waitUntil: "domcontentloaded",
			}),
		).rejects.toThrow("net::ERR_FAILED");
		expect(current().refusals).toContainEqual(
			expect.objectContaining({
				kind: "fetch-failed",
				detail: "TIMEOUT: the request timed out",
				isNavigation: true,
			}),
		);
	});

	it.each(["/cross?status=302", "/second?status=302"])(
		"explains a refused goto operation for %s",
		async (path) => {
			const value = current();
			const outcome = await performOperation(
				value.page,
				{ kind: "goto", path },
				origin,
				value.refusals,
			);
			expect(outcome.ok).toBe(false);
			expect(outcome.detail).toContain(
				"check the environment's base URL",
			);
			expect(trapHits).toBe(0);
		},
	);
	it.each(["/cross?status=302", "/second?status=302"])(
		"returns an initial BLOCKED verdict with zero model calls for %s",
		async (path) => {
			const result = await runAgenticCase(caseInput(path));
			expect(result.result).toBe("BLOCKED");
			expect(result.failureMessage).toContain(
				"check the environment's base URL",
			);
			expect(result.failureMessage).not.toContain("fixture-secret");
			expect(result.modelCalls).toBe(0);
			expect(transport.decide).not.toHaveBeenCalled();
			expect(trapHits).toBe(0);
		},
	);
	it("keeps a mid-run refusal and actual act-call cost without assessing", async () => {
		transport.decide.mockResolvedValueOnce({
			value: { kind: "click", role: "button", name: "Continue" },
			calls: 2,
			via: "text",
		});
		const result = await runAgenticCase(caseInput("/click"));
		expect(result.result).toBe("BLOCKED");
		expect(result.steps[0]?.observation).toContain(
			"check the environment's base URL",
		);
		expect(result.modelCalls).toBe(2);
		expect(transport.decide).toHaveBeenCalledTimes(1);
		expect(trapHits).toBe(0);
	});
	it.each([301, 302, 307])(
		"re-screens same-origin %i and keeps Chromium cookies",
		async (status) => {
			const { page } = current();
			await page.goto(`${origin}/same?status=${status}`);
			await settleNavigation(page);
			expect(await page.textContent("body")).toContain("Final page");
			expect(
				transport.relayed.map((url) => new URL(url).pathname),
			).toContain("/final");
			expect(
				received.find((request) => request.path === "/final"),
			).toMatchObject({
				authorization: "Bearer fixture",
				cookie: "hop=1",
			});
			expect(trapHits).toBe(0);
		},
	);
	it.each([301, 302, 307])(
		"refuses cross-origin %i at first and second hops",
		async (status) => {
			for (const path of ["cross", "second"]) {
				const { page, refusals } = current();
				await page
					.goto(`${origin}/${path}?status=${status}`)
					.catch(() => {});
				await settleNavigation(page).catch(() => {});
				expect(refusals).toContainEqual(
					expect.objectContaining({
						kind: "off-origin",
						isNavigation: true,
					}),
				);
			}
			expect(trapHits).toBe(0);
			expect(
				transport.relayed.every(
					(url) => new URL(url).origin === origin,
				),
			).toBe(true);
			expect(JSON.stringify(current().refusals)).not.toContain(
				"fixture-secret",
			);
		},
	);
	it("rejects a redirect whose next DNS answer is private", async () => {
		const { page, refusals } = current();
		await page.goto(`${origin}/rebind`).catch(() => {});
		await settleNavigation(page).catch(() => {});
		expect(refusals).toContainEqual(
			expect.objectContaining({ kind: "unsafe-address" }),
		);
		expect(received.some((request) => request.path === "/private")).toBe(
			false,
		);
	});
	it("relays same-origin assets and refuses cross-origin asset redirects", async () => {
		const { page, refusals } = current();
		await page.goto(`${origin}/final`);
		expect(
			await page.evaluate(async () => (await fetch("/asset")).text()),
		).toBe("asset");
		expect(
			await page.evaluate(async () =>
				fetch("/asset-cross").then(
					() => "unexpected",
					() => "blocked",
				),
			),
		).toBe("blocked");
		expect(refusals).toContainEqual(
			expect.objectContaining({
				kind: "off-origin",
				isNavigation: false,
			}),
		);
		expect(trapHits).toBe(0);
	});
	it.each([307, 308])(
		"refuses POST %i without replaying its body",
		async (status) => {
			const { page, refusals } = current();
			await page.goto(`${origin}/form?status=${status}`);
			await page.getByRole("button", { name: "Submit" }).click();
			await settleNavigation(page).catch(() => {});
			expect(
				received.find((request) => request.path === "/post")?.method,
			).toBe("POST");
			expect(received.some((request) => request.path === "/final")).toBe(
				false,
			);
			expect(
				refusals.some((refusal) =>
					refusal.detail.includes("would replay a POST"),
				),
			).toBe(true);
		},
	);
	it.each([
		{ kind: "click", role: "button", name: "Save" },
		{ kind: "fill", role: "textbox", name: "Email", text: "fixture" },
		{ kind: "press", key: "Enter" },
		{ kind: "goto", path: "/final" },
		{ kind: "wait", ms: 0 },
	] satisfies BrowserOperation[])(
		"blocks a successful $kind operation when navigation cannot settle",
		async (operation) => {
			const { page, refusals } = current();
			await page.goto(`${origin}/final`);
			await page.setContent(
				'<button>Save</button><input aria-label="Email">',
			);
			const settling = vi
				.spyOn(page, "waitForFunction")
				.mockRejectedValueOnce(
					new Error("Navigation settlement timed out"),
				);
			try {
				const outcome = await performOperation(
					page,
					operation,
					origin,
					refusals,
				);
				expect(outcome).toEqual({
					ok: false,
					detail: "Navigation settlement timed out",
				});
				expect(settling).toHaveBeenCalledOnce();
			} finally {
				settling.mockRestore();
			}
		},
	);
	it("does not mistake a site's own refresh page for the relay document", async () => {
		const { page } = current();
		await page.goto(`${origin}/final`);
		await page.setContent(
			'<title>Redirecting</title><meta http-equiv="refresh" content="3600;url=/final">',
		);
		await settleNavigation(page);
		expect(await page.title()).toBe("Redirecting");
	});
	it("keeps a real credential-bearing URL out of relay warnings", async () => {
		const { page } = current();
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await page
				.goto(
					`${origin.replace("https://", "https://user:fixture-secret@")}/auth?code=fixture-code#fixture-fragment`,
				)
				.catch(() => {});
			const output = warning.mock.calls.flat().map(String).join("\n");
			expect(output).toContain(new URL(origin).host);
			expect(output).not.toContain("fixture-secret");
			expect(output).not.toContain("fixture-code");
			expect(output).not.toContain("fixture-fragment");
		} finally {
			warning.mockRestore();
		}
	});
	it("caps loops and refuses WebSockets before network access", async () => {
		const { page, refusals } = current();
		await page.goto(`${origin}/loop`).catch(() => {});
		await settleNavigation(page).catch(() => {});
		expect(
			received.filter((request) => request.path === "/loop").length,
		).toBeLessThanOrEqual(21);
		expect(
			refusals.some((refusal) =>
				refusal.detail.includes("redirect limit"),
			),
		).toBe(true);
		await page.goto(`${origin}/final`);
		expect(
			await page.evaluate(
				(url) =>
					new Promise<string>((resolve) => {
						const socket = new WebSocket(url);
						socket.onopen = () => resolve("unexpected");
						socket.onerror = () => resolve("blocked");
						socket.onclose = () => resolve("blocked");
					}),
				trapOrigin.replace("http:", "ws:"),
			),
		).toBe("blocked");
		expect(trapHits).toBe(0);
	});
});
