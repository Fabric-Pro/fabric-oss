import { createQueryClient } from "@shared/lib/query-client";
import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

/**
 * Capability gates are derived from live project state, so almost any mutation
 * on a project can change one (Fizzy #1930). The query lives in a provider
 * mounted on the project layout, which no mutation remounts.
 *
 * The first fix for this was per-mutation and wired only the scan configuration
 * save; deleting a project's documents then reproduced the same staleness,
 * because it is a different mutation. These tests pin the central behaviour so
 * the fix cannot quietly narrow back to one call site.
 */

/** Mount the gate query the way the provider keys it, and record refetches. */
function mountGateQuery(client: QueryClient) {
	let fetches = 0;
	const queryKey = ["capability-gates", "project-1", "org-1"];
	const observer = client
		.getQueryCache()
		.build(client, { queryKey, queryFn: async () => ++fetches });
	observer.fetch();
	return {
		queryKey,
		get fetches() {
			return fetches;
		},
	};
}

async function runMutation(client: QueryClient) {
	await client
		.getMutationCache()
		.build(client, { mutationFn: async () => ({ ok: true }) })
		.execute(undefined);
}

describe("createQueryClient — capability gate freshness", () => {
	it("invalidates the gate matrix after a successful mutation", async () => {
		const client = createQueryClient();
		const gates = mountGateQuery(client);
		await client.getQueryCache().find({ queryKey: gates.queryKey })
			?.promise;
		const before = gates.fetches;

		await runMutation(client);

		const state = client.getQueryState(gates.queryKey);
		expect(state?.isInvalidated).toBe(true);
		expect(before).toBeGreaterThan(0);
	});

	it("leaves an unrelated query alone", async () => {
		const client = createQueryClient();
		const other = ["scan-config", "project-1"];
		client
			.getQueryCache()
			.build(client, { queryKey: other, queryFn: async () => 1 })
			.fetch();
		await client.getQueryCache().find({ queryKey: other })?.promise;

		await runMutation(client);

		expect(client.getQueryState(other)?.isInvalidated).toBe(false);
	});
});

describe("createQueryClient — a refusal at a door refreshes the gates", () => {
	async function failMutation(client: QueryClient, code: string) {
		await client
			.getMutationCache()
			.build(client, {
				mutationFn: async () => {
					throw Object.assign(new Error("refused"), { code });
				},
			})
			.execute(undefined)
			.catch(() => {});
	}

	it("invalidates the gate matrix after a PRECONDITION_FAILED", async () => {
		// The one moment the page is provably stale: it offered an action the
		// server just refused (Fizzy #1930).
		const client = createQueryClient();
		const gates = mountGateQuery(client);
		await client.getQueryCache().find({ queryKey: gates.queryKey })
			?.promise;

		await failMutation(client, "PRECONDITION_FAILED");

		expect(client.getQueryState(gates.queryKey)?.isInvalidated).toBe(true);
	});

	it("does not refresh on any other failure", async () => {
		const client = createQueryClient();
		const gates = mountGateQuery(client);
		await client.getQueryCache().find({ queryKey: gates.queryKey })
			?.promise;

		await failMutation(client, "INTERNAL_SERVER_ERROR");

		expect(client.getQueryState(gates.queryKey)?.isInvalidated).toBe(false);
	});
});
