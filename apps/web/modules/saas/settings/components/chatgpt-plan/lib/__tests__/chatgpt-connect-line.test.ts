/**
 * The `fabric connect chatgpt` line each deployment shows (Fizzy #2770),
 * built like the Connect dialog's setup line so it works where it is shown.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CLI_DEFAULT_ORIGIN,
	chatgptConnectLines,
} from "../chatgpt-connect-line";

const STAGING = "https://staging.example.com";

const document = (origin: string | null) => ({
	spec: 1 as const,
	version: "0.4.0",
	minSupported: "0.4.0",
	nodeRange: ">=22",
	origin,
	integrity: "sha512-abc=",
	tarball: `${origin ?? "https://build.example.com"}/cli/fabric-0.4.0-0123456789.tgz`,
});

describe("chatgptConnectLines", () => {
	it("runs the served CLI without --base-url where the tarball is baked for this address", () => {
		expect(
			chatgptConnectLines({
				document: document(STAGING),
				origin: STAGING,
			}),
		).toEqual({
			primary: `npx -y ${STAGING}/cli/fabric-0.4.0-0123456789.tgz connect chatgpt`,
			primaryKind: "served",
			servedLine: null,
		});
	});

	it("adds --base-url on any other address, with the tarball from the page's own host", () => {
		const { primary } = chatgptConnectLines({
			document: document(null),
			origin: STAGING,
			sharedOrganizationSlug: "example-org",
		});
		expect(primary).toBe(
			`npx -y ${STAGING}/cli/fabric-0.4.0-0123456789.tgz connect chatgpt --org example-org --shared --base-url ${STAGING}`,
		);
	});

	it("falls back to the installed CLI when the deployment serves none", () => {
		expect(
			chatgptConnectLines({
				document: null,
				origin: STAGING,
				sharedOrganizationSlug: "example-org",
			}),
		).toEqual({
			primary: "fabric connect chatgpt --org example-org --shared",
			primaryKind: "installed",
			servedLine: null,
		});
	});

	it("shows the plain line on the default address, offering the served CLI for someone without one", () => {
		expect(
			chatgptConnectLines({
				document: document(CLI_DEFAULT_ORIGIN),
				origin: CLI_DEFAULT_ORIGIN,
			}),
		).toEqual({
			primary: "fabric connect chatgpt",
			primaryKind: "installed",
			servedLine: `npx -y ${CLI_DEFAULT_ORIGIN}/cli/fabric-0.4.0-0123456789.tgz connect chatgpt`,
		});
	});

	it("agrees with the CLI on its default address", () => {
		const source = readFileSync(
			resolve(
				__dirname,
				"../../../../../../../../../packages/cli/src/lib/origin.ts",
			),
			"utf8",
		);
		expect(source).toContain(
			`export const DEFAULT_ORIGIN = "${CLI_DEFAULT_ORIGIN}";`,
		);
	});
});
