/**
 * The `fabric connect chatgpt` line each deployment shows (Fizzy #2770),
 * built like the Connect dialog's setup line so it works where it is shown.
 */
import { describe, expect, it } from "vitest";
import { chatgptConnectLines } from "../chatgpt-connect-line";

const STAGING = "https://staging.example.com";
const DEFAULT_ORIGIN = "https://fabric.pro";

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
	it("pins the served CLI to the page even where the tarball is baked for this address", () => {
		expect(
			chatgptConnectLines({
				document: document(STAGING),
				origin: STAGING,
			}),
		).toEqual({
			primary: `npx -y ${STAGING}/cli/fabric-0.4.0-0123456789.tgz connect chatgpt --base-url ${STAGING}`,
			primaryKind: "served",
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
			primary: `fabric connect chatgpt --org example-org --shared --base-url ${STAGING}`,
			primaryKind: "installed",
		});
	});

	it("leads with the served CLI on the CLI's own default address too, so nothing has to be installed first", () => {
		expect(
			chatgptConnectLines({
				document: document(DEFAULT_ORIGIN),
				origin: DEFAULT_ORIGIN,
			}),
		).toEqual({
			primary: `npx -y ${DEFAULT_ORIGIN}/cli/fabric-0.4.0-0123456789.tgz connect chatgpt --base-url ${DEFAULT_ORIGIN}`,
			primaryKind: "served",
		});
	});
});
