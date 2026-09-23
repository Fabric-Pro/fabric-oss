/**
 * `fabric instructions doctor --probe-network`: the bounds on the one network
 * request doctor makes to a URL somebody else chose (Fizzy #2653).
 *
 * Each property here is one a probe could silently lose while every
 * "reachable / refused" test still passed, so each test is built to FAIL if
 * its property is removed:
 *
 *  - `redirect: "manual"`: a 3xx is the answer, and no second request is sent;
 *  - the response body is cancelled once the status line has arrived;
 *  - each request is aborted at 5 seconds;
 *  - at most 20 servers are probed, at most 4 at a time, within 15 seconds in
 *    total, and whatever the budget does not reach is skipped.
 *
 * `runDoctor` is called directly with an injected `fetch` and no API key, so
 * every server-backed check skips and `mcp-servers` is the only thing that
 * does any work.
 */
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	CheckItem,
	InstructionCheck,
} from "../src/lib/instructions/checks.js";
import { type DoctorInput, runDoctor } from "../src/lib/instructions/doctor.js";

const PASS_DETAIL = "an HTTP response is not proof of a working MCP server";
const EXHAUSTED: CheckItem["detail"] = "probe budget exhausted";

async function treeWithServers(count: number): Promise<string> {
	const root = await realpath(
		await mkdtemp(path.join(tmpdir(), "fabric-doctor-probe-")),
	);
	const mcpServers: Record<string, { url: string }> = {};
	for (let index = 0; index < count; index++) {
		mcpServers[`server-${index}`] = {
			url: `https://probe-${index}.example.com/mcp`,
		};
	}
	await writeFile(
		path.join(root, ".mcp.json"),
		JSON.stringify({ mcpServers }),
		"utf8",
	);
	return root;
}

function inputFor(root: string, fetchImpl: typeof fetch): DoctorInput {
	const unreachable = () => {
		throw new Error("not used: no API key is configured in this test");
	};
	return {
		projectId: "project-1",
		destination: root,
		root,
		probeNetwork: true,
		env: {},
		platform: "linux",
		apiKeyPresent: false,
		client: unreachable,
		createDownloadUrl: async () => unreachable(),
		fetchArchive: async () => unreachable(),
		fetchImpl,
	};
}

async function mcpCheck(input: DoctorInput): Promise<InstructionCheck> {
	const report = await runDoctor(input);
	const check = report.checks.find(
		(candidate) => candidate.id === "mcp-servers",
	);
	if (!check) {
		throw new Error("no mcp-servers check in the report");
	}
	return check;
}

/** A fetch that never answers on its own, only rejects when aborted. */
function abortOnly(signal: AbortSignal | null | undefined): Promise<never> {
	return new Promise((_, reject) => {
		signal?.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe("--probe-network redirects", () => {
	it("asks for redirect: manual and counts a 3xx as reachable without a second request", async () => {
		const root = await treeWithServers(1);
		const fetchImpl = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(null, {
					status: 302,
					headers: { location: "https://elsewhere.example.com/" },
				}),
		);

		const check = await mcpCheck(
			inputFor(root, fetchImpl as unknown as typeof fetch),
		);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(url).toBe("https://probe-0.example.com/mcp");
		expect(init?.redirect).toBe("manual");
		expect(init?.method).toBe("GET");
		// No headers at all, so none from the config can ride along.
		expect(init?.headers).toBeUndefined();
		expect(check.items).toEqual([
			{
				name: "server-0",
				status: "pass",
				detail: `reachable (HTTP 302); ${PASS_DETAIL}`,
			},
		]);
	});

	it("does not follow a real server's redirect", async () => {
		const paths: string[] = [];
		const server = createServer((request, response) => {
			paths.push(request.url ?? "");
			response.writeHead(302, { location: "/followed" });
			response.end();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", () => resolve()),
		);
		try {
			const { port } = server.address() as AddressInfo;
			const root = await treeWithServers(0);
			await writeFile(
				path.join(root, ".mcp.json"),
				JSON.stringify({
					mcpServers: {
						local: { url: `http://127.0.0.1:${port}/mcp` },
					},
				}),
				"utf8",
			);

			const check = await mcpCheck(inputFor(root, fetch));

			expect(paths).toEqual(["/mcp"]);
			expect(check.items?.[0]).toMatchObject({
				name: "local",
				status: "pass",
			});
			expect(check.items?.[0]?.detail).toMatch(/^reachable \(/);
		} finally {
			server.close();
		}
	});
});

describe("--probe-network response bodies", () => {
	it("cancels the body once the status line has arrived", async () => {
		const root = await treeWithServers(1);
		let cancelled = false;
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							controller.enqueue(new Uint8Array(1024));
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ status: 200 },
				),
		);

		const check = await mcpCheck(
			inputFor(root, fetchImpl as unknown as typeof fetch),
		);

		expect(check.items?.[0]?.status).toBe("pass");
		expect(cancelled).toBe(true);
	});
});

describe("--probe-network time bounds", () => {
	it("aborts a request at 5 seconds, not before", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const root = await treeWithServers(1);
		const signals: AbortSignal[] = [];
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const fetchImpl = vi.fn(
			(_url: string | URL | Request, init?: RequestInit) => {
				if (init?.signal) {
					signals.push(init.signal);
				}
				markStarted();
				return abortOnly(init?.signal);
			},
		);

		const run = mcpCheck(
			inputFor(root, fetchImpl as unknown as typeof fetch),
		);
		await started;
		await vi.advanceTimersByTimeAsync(4_999);
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(signals[0]?.aborted).toBe(true);

		const check = await run;
		expect(check.items).toEqual([
			{ name: "server-0", status: "fail", detail: "timed out" },
		]);
	});

	/**
	 * Every server answers after 4 s. Four at a time: waves start at 0, 4 and
	 * 8 s and pass; the wave at 12 s has 3 s of budget left, so it is cut off
	 * at 15 s; the last four are never sent.
	 */
	it("stops at the 15-second budget and skips the servers it did not reach", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const root = await treeWithServers(20);
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const fetchImpl = vi.fn(
			(_url: string | URL | Request, init?: RequestInit) => {
				markStarted();
				return Promise.race([
					abortOnly(init?.signal),
					new Promise<Response>((resolve) =>
						setTimeout(
							() => resolve(new Response(null, { status: 200 })),
							4_000,
						),
					),
				]);
			},
		);

		let finishedAt: number | undefined;
		const run = mcpCheck(
			inputFor(root, fetchImpl as unknown as typeof fetch),
		).then((check) => {
			finishedAt = Date.now();
			return check;
		});
		await started;
		const startedAt = Date.now();
		// Well past the budget, so a run that ignored it would still finish.
		await vi.advanceTimersByTimeAsync(30_000);
		const check = await run;

		expect(fetchImpl).toHaveBeenCalledTimes(16);
		const statuses = check.items?.map((item) => item.status);
		expect(statuses).toEqual([
			...Array(12).fill("pass"),
			...Array(4).fill("fail"),
			...Array(4).fill("skip"),
		]);
		expect(check.items?.slice(12, 16).map((item) => item.detail)).toEqual(
			Array(4).fill("timed out"),
		);
		expect(check.items?.slice(16).map((item) => item.detail)).toEqual(
			Array(4).fill(EXHAUSTED),
		);
		expect((finishedAt ?? Number.POSITIVE_INFINITY) - startedAt).toBe(
			15_000,
		);
	});
});

describe("--probe-network volume bounds", () => {
	it("probes at most 20 servers and skips the rest", async () => {
		const root = await treeWithServers(25);
		const fetchImpl = vi.fn(
			async () => new Response(null, { status: 204 }),
		);

		const check = await mcpCheck(
			inputFor(root, fetchImpl as unknown as typeof fetch),
		);

		expect(fetchImpl).toHaveBeenCalledTimes(20);
		expect(check.items).toHaveLength(25);
		expect(
			check.items?.slice(0, 20).every((item) => item.status === "pass"),
		).toBe(true);
		expect(check.items?.slice(20)).toEqual(
			Array.from({ length: 5 }, (_, offset) => ({
				name: `server-${20 + offset}`,
				status: "skip",
				detail: EXHAUSTED,
			})),
		);
	});

	it("never has more than 4 requests in flight", async () => {
		const root = await treeWithServers(12);
		let inFlight = 0;
		let highest = 0;
		const fetchImpl = vi.fn(async () => {
			inFlight++;
			highest = Math.max(highest, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 10));
			inFlight--;
			return new Response(null, { status: 200 });
		});

		const check = await mcpCheck(
			inputFor(root, fetchImpl as unknown as typeof fetch),
		);

		expect(fetchImpl).toHaveBeenCalledTimes(12);
		expect(highest).toBe(4);
		expect(check.items?.every((item) => item.status === "pass")).toBe(true);
	});
});
