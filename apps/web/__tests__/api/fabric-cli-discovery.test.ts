// @vitest-environment node
/**
 * `GET /.well-known/fabric-cli.json` tells a person, or a script, which CLI
 * this deployment serves.
 *
 * Asserted against a real `public/cli/manifest.json` in a temporary directory,
 * because the route's whole job is to turn that file into an answer; mocking
 * the reader would leave untested the file format the route and the pack
 * script have to agree on.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const MANIFEST = {
	spec: 1,
	version: "0.4.0",
	minSupported: "0.4.0",
	nodeRange: ">=22",
	origin: "https://fabric.example.com" as string | null,
	tarball: "/cli/fabric-0.4.0.tgz",
	integrity:
		"sha512-gs0KTkSwaASijxIqwSDGS2+zgB7ztmUss3KGk2FSJtWwW1lV6xyxvhfPm30zh14w8/A1yEfFl+kz96Ujga5gDg==",
};

const ASKED_AT = "https://staging.example.com";

let root: string;

function packManifest(content: string) {
	mkdirSync(path.join(root, "public", "cli"), { recursive: true });
	writeFileSync(path.join(root, "public", "cli", "manifest.json"), content);
}

function request() {
	return new Request(`${ASKED_AT}/.well-known/fabric-cli.json`);
}

describe("/.well-known/fabric-cli.json", () => {
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "fabric-cli-discovery-"));
		vi.spyOn(process, "cwd").mockReturnValue(root);
		// What the running server is configured with says nothing about the
		// address it was asked at, and the document must not guess from it.
		vi.stubEnv(
			"NEXT_PUBLIC_SITE_URL",
			"https://configured-at-runtime.example.com",
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("answers from the packed manifest, with the tarball on the host that was asked and the baked origin beside it", async () => {
		packManifest(JSON.stringify(MANIFEST));
		const { GET } = await import(
			"../../app/.well-known/fabric-cli.json/route"
		);

		const response = await GET(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			version: "0.4.0",
			spec: 1,
			integrity: MANIFEST.integrity,
			minSupported: "0.4.0",
			nodeRange: ">=22",
			origin: "https://fabric.example.com",
			tarball: `${ASKED_AT}/cli/fabric-0.4.0.tgz`,
		});
		expect(response.headers.get("Cache-Control")).toBe(
			"public, max-age=60",
		);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("puts the tarball on the host the client asked for, not the address the server is bound to", async () => {
		packManifest(JSON.stringify(MANIFEST));
		const { GET } = await import(
			"../../app/.well-known/fabric-cli.json/route"
		);

		// The dev server binds 0.0.0.0, so request.url names that; the client
		// asked localhost.
		const bound = await GET(
			new Request("http://0.0.0.0:3001/.well-known/fabric-cli.json", {
				headers: { host: "localhost:3001" },
			}),
		);
		expect((await bound.json()).tarball).toBe(
			"http://localhost:3001/cli/fabric-0.4.0.tgz",
		);

		// Behind a proxy the forwarded headers name the public address.
		const proxied = await GET(
			new Request("http://10.0.0.7:3000/.well-known/fabric-cli.json", {
				headers: {
					host: "10.0.0.7:3000",
					"x-forwarded-host": "staging.example.com",
					"x-forwarded-proto": "https",
				},
			}),
		);
		expect((await proxied.json()).tarball).toBe(
			"https://staging.example.com/cli/fabric-0.4.0.tgz",
		);

		// A header that is not a host literal is ignored, never echoed.
		const hostile = await GET(
			new Request(`${ASKED_AT}/.well-known/fabric-cli.json`, {
				headers: { "x-forwarded-host": "evil.example/x?y=<script>" },
			}),
		);
		expect((await hostile.json()).tarball).toBe(
			`${ASKED_AT}/cli/fabric-0.4.0.tgz`,
		);
	});

	it("serves a CLI built without an origin, and says so with a null", async () => {
		packManifest(JSON.stringify({ ...MANIFEST, origin: null }));
		const { GET } = await import(
			"../../app/.well-known/fabric-cli.json/route"
		);

		const response = await GET(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			origin: null,
			tarball: `${ASKED_AT}/cli/fabric-0.4.0.tgz`,
		});
	});

	it("says plainly that no CLI is served when nothing was packed", async () => {
		const { GET } = await import(
			"../../app/.well-known/fabric-cli.json/route"
		);

		const response = await GET(request());

		expect(response.status).toBe(404);
		const body = (await response.json()) as {
			error: string;
			message: string;
		};
		expect(body.error).toBe("cli_not_served");
		expect(body.message).toContain("does not serve the Fabric CLI");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("does not serve a manifest it cannot read as the pack script wrote it", async () => {
		packManifest(
			JSON.stringify({ ...MANIFEST, tarball: "/elsewhere.tgz" }),
		);
		const { GET } = await import(
			"../../app/.well-known/fabric-cli.json/route"
		);

		const response = await GET(request());

		expect(response.status).toBe(404);
	});

	it("does not serve a manifest from before the origin was recorded", async () => {
		const { origin: _origin, ...withoutOrigin } = MANIFEST;
		packManifest(JSON.stringify(withoutOrigin));
		const { GET } = await import(
			"../../app/.well-known/fabric-cli.json/route"
		);

		const response = await GET(request());

		expect(response.status).toBe(404);
	});

	it("answers the CORS preflight a browser-based client sends", async () => {
		const { OPTIONS } = await import(
			"../../app/.well-known/fabric-cli.json/route"
		);

		const response = OPTIONS();

		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
			"GET, OPTIONS",
		);
	});
});
