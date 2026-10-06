/**
 * The Azure DevOps client's rejected-PAT path, end to end through the real
 * classifier.
 *
 * ADO answers an invalid or expired PAT with a 302 to, or a 203 carrying, the
 * HTML sign-in page — never a 401. `Response.ok` is true for 203, so the client
 * must name 203 explicitly, ahead of its 2xx range test, or the sign-in page
 * would be parsed as JSON.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { classifySyncFailure } from "../../sync-failure-classification";
import { createAdoPatClient } from "../ado-client";
import { ProviderHttpError } from "../provider-http-error";

const realFetch = globalThis.fetch;

function mockFetch(
	status: number,
	headers: Record<string, string>,
	body: string,
) {
	globalThis.fetch = vi.fn(
		async () => new Response(body, { status, headers }),
	) as unknown as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

describe("createAdoPatClient error reporting", () => {
	it("returns the parsed body on a 200", async () => {
		mockFetch(200, { "content-type": "application/json" }, '{"count":1}');
		const client = createAdoPatClient("example-org", "pat");

		await expect(client.get("/proj/_apis/build/builds")).resolves.toEqual({
			count: 1,
		});
	});

	it("maps ADO's 203 sign-in page to UNAUTHENTICATED → CREDENTIAL_REJECTED", async () => {
		mockFetch(203, { "content-type": "text/html" }, "<html>sign in</html>");
		const client = createAdoPatClient("example-org", "pat");

		const err = await client
			.get("/proj/_apis/build/builds")
			.catch((e: unknown) => e);

		expect(err).toBeInstanceOf(ProviderHttpError);
		expect((err as ProviderHttpError).kind).toBe("UNAUTHENTICATED");
		expect(classifySyncFailure(err).kind).toBe("CREDENTIAL_REJECTED");
	});

	it("maps a 302 to the sign-in page the same way", async () => {
		mockFetch(302, { location: "https://login.example.com/" }, "");
		const client = createAdoPatClient("example-org", "pat");

		const err = await client
			.get("/proj/_apis/build/builds")
			.catch((e: unknown) => e);

		expect(err).toBeInstanceOf(ProviderHttpError);
		expect((err as ProviderHttpError).kind).toBe("UNAUTHENTICATED");
	});

	it("maps a real 401 the same way", async () => {
		mockFetch(401, {}, "unauthorized");
		const client = createAdoPatClient("example-org", "pat");

		const err = await client
			.get("/proj/_apis/build/builds")
			.catch((e: unknown) => e);

		expect((err as ProviderHttpError).kind).toBe("UNAUTHENTICATED");
	});

	it("does not call a 429 an auth failure", async () => {
		mockFetch(429, { "retry-after": "5" }, "");
		const client = createAdoPatClient("example-org", "pat");

		const err = await client
			.get("/proj/_apis/build/builds")
			.catch((e: unknown) => e);

		expect((err as ProviderHttpError).kind).not.toBe("UNAUTHENTICATED");
	});
});
