/**
 * The probe asks about an address only when it is on the deployment's own
 * origin, with one unauthenticated request that follows nothing, and treats
 * everything it cannot read as unknown. A fetch stands in for the network and
 * writes down every request it was asked for.
 */
import { describe, expect, it } from "vitest";
import {
	gatewayProbeFor,
	type ProbeFetch,
} from "../src/lib/instructions/gateway-probe.js";

const ORIGIN = "https://deploy.example.com";
const PROJECT = "project-example-one";
const ODD = `${ORIGIN}/mcp`;
const METADATA = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;

interface Request {
	url: string;
	init: RequestInit;
}

function challenge(metadata: string | null): Response {
	return new Response("{}", {
		status: 401,
		headers:
			metadata === null
				? {}
				: {
						"www-authenticate": `Bearer resource_metadata="${metadata}", scope="x"`,
					},
	});
}

function metadataNaming(resource: unknown): Response {
	return new Response(JSON.stringify({ resource }), { status: 200 });
}

function probeWith(answers: Array<Response | Error>) {
	const requests: Request[] = [];
	const fetcher: ProbeFetch = async (url, init) => {
		requests.push({ url, init });
		const next = answers.shift();
		if (next === undefined) {
			throw new Error("unexpected request");
		}
		if (next instanceof Error) {
			throw next;
		}
		return next;
	};
	return {
		probe: gatewayProbeFor({
			origin: ORIGIN,
			projectId: PROJECT,
			fetch: fetcher,
		}),
		requests,
	};
}

describe("gatewayProbeFor", () => {
	it.each([
		[
			"this project",
			`${ORIGIN}/api/mcp-gateway/projects/${PROJECT}`,
			"this-project",
		],
		[
			"another project",
			`${ORIGIN}/api/mcp-gateway/projects/project-example-two`,
			"other-project",
		],
		["the organization", `${ORIGIN}/api/mcp-gateway`, "org-wide"],
		[
			"this project's REST API",
			`${ORIGIN}/api/v1/projects/${PROJECT}`,
			"this-project",
		],
	])(
		"names %s by the resource the metadata gives",
		async (_label, resource, expected) => {
			const { probe, requests } = probeWith([
				challenge(METADATA),
				metadataNaming(resource),
			]);

			expect(await probe(ODD)).toBe(expected);
			expect(requests.map((request) => request.url)).toEqual([
				ODD,
				METADATA,
			]);
		},
	);

	it("sends nothing but a plain GET: no credentials, no redirect followed, a short time limit", async () => {
		const { probe, requests } = probeWith([
			challenge(METADATA),
			metadataNaming(`${ORIGIN}/api/mcp-gateway`),
		]);

		await probe(ODD);

		for (const { init } of requests) {
			expect(init.method).toBe("GET");
			expect(init.redirect).toBe("manual");
			expect(init.credentials).toBe("omit");
			expect(init.signal).toBeInstanceOf(AbortSignal);
			expect(Object.keys(init.headers ?? {})).toEqual(["accept"]);
		}
	});

	it("never asks about another host", async () => {
		const { probe, requests } = probeWith([]);

		expect(await probe("https://mcp.vendor.example.net/mcp")).toBe(
			"unknown",
		);
		expect(requests).toEqual([]);
	});

	it("does not follow metadata that lives on another host", async () => {
		const { probe, requests } = probeWith([
			challenge("https://metadata.example.net/meta"),
		]);

		expect(await probe(ODD)).toBe("unknown");
		expect(requests.map((request) => request.url)).toEqual([ODD]);
	});

	it.each([
		["a page", new Response("hi", { status: 200 })],
		[
			"a redirect",
			new Response(null, {
				status: 302,
				headers: { location: "https://elsewhere.example.net/" },
			}),
		],
		["a 401 with no challenge", challenge(null)],
		["a 404", new Response("no", { status: 404 })],
	])("calls %s not Fabric's", async (_label, answer) => {
		const { probe, requests } = probeWith([answer]);

		expect(await probe(ODD)).toBe("foreign");
		expect(requests).toHaveLength(1);
	});

	it.each([
		["a server error", [new Response("x", { status: 503 })]],
		["a network failure", [new Error("connect ECONNREFUSED")]],
		[
			"a timeout",
			[Object.assign(new Error("timed out"), { name: "TimeoutError" })],
		],
		[
			"metadata that fails",
			[challenge(METADATA), new Response("x", { status: 500 })],
		],
		[
			"metadata that is not JSON",
			[challenge(METADATA), new Response("<html>", { status: 200 })],
		],
		[
			"metadata that names no resource",
			[challenge(METADATA), metadataNaming(undefined)],
		],
		[
			"metadata that names a resource that is not a string",
			[challenge(METADATA), metadataNaming(7)],
		],
		[
			"metadata that names an address of no known shape",
			[challenge(METADATA), metadataNaming(`${ORIGIN}/else`)],
		],
		[
			"metadata that is far too large",
			[
				challenge(METADATA),
				new Response("x".repeat(70_000), { status: 200 }),
			],
		],
	])("says unknown for %s", async (_label, answers) => {
		const { probe } = probeWith([...answers]);

		expect(await probe(ODD)).toBe("unknown");
	});
});
