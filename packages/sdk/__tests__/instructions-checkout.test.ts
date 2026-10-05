/**
 * What a checkout needs from the SDK (Fizzy #2878): resolving a remote to the
 * projects that use it, the new fields of the published answer, the
 * `User-Agent` a CLI build identifies itself with, and the upgrade notice a
 * server can attach to any response.
 *
 * `fetch` is stubbed and the assertions are about the request that leaves the
 * client and what the client does with the response.
 */
import { describe, expect, it } from "vitest";
import {
	createFabric,
	type FabricClientOptions,
	type PublishedInstructions,
	type ResolvedInstructionCheckouts,
} from "../src/index.js";

interface Captured {
	url: string;
	method: string;
	body: unknown;
	headers: Headers;
}

function build(
	respond: () => Response,
	options: Partial<FabricClientOptions> = {},
) {
	const captured: Captured[] = [];
	const client = createFabric({
		apiKey: "fab_test_key",
		baseUrl: "https://test.fabric",
		retry: { maxRetries: 0 },
		fetch: async (input, init) => {
			captured.push({
				url: String(input),
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
				headers: new Headers(init?.headers),
			});
			return respond();
		},
		...options,
	});
	return { client, captured };
}

function ok(data: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify({ data }), {
		status: 200,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

describe("InstructionsResource.resolveCheckout", () => {
	const answer: ResolvedInstructionCheckouts = {
		matches: [
			{
				projectId: "project-1",
				projectName: "Rules",
				organizationSlug: "example-org",
				provider: "GITHUB",
				host: "github.com",
				path: "example-org/rules",
				ref: "main",
				rootPath: "",
				cloneUrl: "https://github.com/example-org/rules",
			},
		],
	};

	it("POSTs the candidates to the checkout resolver and returns the matches", async () => {
		const { client, captured } = build(() => ok(answer));

		const result = await client.instructions.resolveCheckout([
			"https://github.com/example-org/rules",
			"https://github.com/example-org/other",
		]);

		expect(result).toEqual(answer);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.method).toBe("POST");
		expect(captured[0]?.url).toBe(
			"https://test.fabric/api/v1/instructions/checkouts/resolve",
		);
		expect(captured[0]?.body).toEqual({
			candidates: [
				"https://github.com/example-org/rules",
				"https://github.com/example-org/other",
			],
		});
	});

	it("adds no organization when the client has no default context", async () => {
		const { client, captured } = build(() => ok({ matches: [] }), {
			org: "example-org",
		});

		await client
			.withoutContext()
			.instructions.resolveCheckout([
				"https://github.com/example-org/rules",
			]);

		expect(captured[0]?.url).not.toContain("org=");
	});
});

describe("the published answer's repository block", () => {
	it("carries the clone URL and how Fabric's copy follows the branch", async () => {
		const published = {
			published: true,
			sourceOfTruth: "REPOSITORY",
			repository: {
				provider: "AZURE_DEVOPS",
				host: "dev.azure.com",
				path: "example-org/Example%20Project/_git/rules",
				ref: "main",
				rootPath: "",
				generation: 3,
				cloneUrl:
					"https://dev.azure.com/example-org/Example%20Project/_git/rules",
				sync: {
					automatic: true,
					pausedReason: null,
					lastRun: {
						trigger: "WEBHOOK",
						status: "FAILED",
						error: "TREE_REFUSED",
						commitSha: "a".repeat(40),
						finishedAt: "2026-10-02T10:00:00.000Z",
					},
				},
			},
		} satisfies PublishedInstructions;
		const { client } = build(() => ok(published));

		const result = await client.instructions.getPublished("project-1");

		expect(result.repository?.cloneUrl).toBe(
			"https://dev.azure.com/example-org/Example%20Project/_git/rules",
		);
		expect(result.repository?.sync?.lastRun?.error).toBe("TREE_REFUSED");
	});

	it("allows a legacy clone URL that is null and a sync run that is still open", async () => {
		const published = {
			published: true,
			sourceOfTruth: "REPOSITORY",
			repository: {
				provider: "GITHUB",
				host: "github.com",
				path: "example-org/rules",
				ref: "main",
				rootPath: "",
				generation: 1,
				cloneUrl: null,
				sync: {
					automatic: false,
					pausedReason: "MIGRATING",
					lastRun: {
						trigger: "MANUAL",
						status: null,
						error: null,
						commitSha: null,
						finishedAt: null,
					},
				},
			},
		} satisfies PublishedInstructions;
		const { client } = build(() => ok(published));

		const result = await client.instructions.getPublished("project-1");

		expect(result.repository?.cloneUrl).toBeNull();
		expect(result.repository?.sync?.lastRun?.status).toBeNull();
	});
});

describe("User-Agent", () => {
	it("sends the configured user agent on every request", async () => {
		const { client, captured } = build(() => ok({ matches: [] }), {
			userAgent: "fabric-cli/0.5.0 (node/22.0.0; linux)",
		});

		await client.instructions.resolveCheckout(["https://github.com/o/r"]);

		expect(captured[0]?.headers.get("user-agent")).toBe(
			"fabric-cli/0.5.0 (node/22.0.0; linux)",
		);
	});

	it("keeps it on a client with its default context removed", async () => {
		const { client, captured } = build(() => ok({ matches: [] }), {
			userAgent: "fabric-cli/0.5.0 (node/22.0.0; linux)",
			org: "example-org",
		});

		await client
			.withoutContext()
			.instructions.resolveCheckout(["https://github.com/o/r"]);

		expect(captured[0]?.headers.get("user-agent")).toBe(
			"fabric-cli/0.5.0 (node/22.0.0; linux)",
		);
	});

	it("sets no user agent of its own when none is configured", async () => {
		const { client, captured } = build(() => ok({ matches: [] }));

		await client.instructions.resolveCheckout(["https://github.com/o/r"]);

		expect(captured[0]?.headers.has("user-agent")).toBe(false);
	});
});

describe("the upgrade notice", () => {
	const line =
		"This CLI is older than the deployment expects. Run: npx -y https://test.fabric/cli/fabric-0.5.0.tgz instructions init";

	it("hands the exact header value to the caller on a successful response", async () => {
		const notices: string[] = [];
		const { client } = build(
			() => ok({ matches: [] }, { "X-Fabric-Cli-Upgrade": line }),
			{ onUpgradeNotice: (value) => notices.push(value) },
		);

		await client.instructions.resolveCheckout(["https://github.com/o/r"]);

		expect(notices).toEqual([line]);
	});

	it("hands it over on an error response too, and still throws the error", async () => {
		const notices: string[] = [];
		const { client } = build(
			() =>
				new Response(JSON.stringify({ error: "Upgrade required" }), {
					status: 426,
					headers: {
						"Content-Type": "application/json",
						"X-Fabric-Cli-Upgrade": line,
					},
				}),
			{ onUpgradeNotice: (value) => notices.push(value) },
		);

		await expect(
			client.instructions.resolveCheckout(["https://github.com/o/r"]),
		).rejects.toMatchObject({ status: 426 });
		expect(notices).toEqual([line]);
	});

	it("calls nothing when the response carries no notice", async () => {
		const notices: string[] = [];
		const { client } = build(() => ok({ matches: [] }), {
			onUpgradeNotice: (value) => notices.push(value),
		});

		await client.instructions.resolveCheckout(["https://github.com/o/r"]);

		expect(notices).toEqual([]);
	});

	it("is not broken by a handler that throws", async () => {
		const { client } = build(
			() => ok({ matches: [] }, { "X-Fabric-Cli-Upgrade": line }),
			{
				onUpgradeNotice: () => {
					throw new Error("handler failed");
				},
			},
		);

		await expect(
			client.instructions.resolveCheckout(["https://github.com/o/r"]),
		).resolves.toEqual({ matches: [] });
	});
});
