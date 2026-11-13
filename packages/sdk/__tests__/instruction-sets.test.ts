/**
 * `projects.*InstructionSet*`: the v1 routes each method calls, and the
 * refusal code a caller branches on.
 */
import { describe, expect, it } from "vitest";
import { createFabric, FabricError } from "../src/index.js";

interface Captured {
	url: string;
	method: string;
	body: unknown;
}

function client(response: { status?: number; body?: unknown } = {}) {
	const captured: Captured[] = [];
	const stub: typeof fetch = async (input, init) => {
		captured.push({
			url: typeof input === "string" ? input : input.toString(),
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(init.body as string) : null,
		});
		return new Response(
			JSON.stringify(response.body ?? { data: { set: { id: "set_1" } } }),
			{
				status: response.status ?? 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	};
	return {
		fabric: createFabric({
			apiKey: "fab_test_key",
			baseUrl: "https://test.fabric",
			fetch: stub,
			retry: { maxRetries: 0 },
		}),
		captured,
	};
}

const BASE = "https://test.fabric/api/v1/projects/proj_1/instructions/sets";

describe("projects instruction sets", () => {
	it("lists with GET", async () => {
		const { fabric, captured } = client({ body: { data: { sets: [] } } });
		await fabric.projects.listInstructionSets("proj_1");
		expect(captured[0]).toMatchObject({ method: "GET", url: BASE });
	});

	it("creates with POST and the body as given", async () => {
		const { fabric, captured } = client();
		await fabric.projects.createInstructionSet("proj_1", {
			name: "Mobile apps",
			repositoryIntegrationIds: ["int_web"],
		});
		expect(captured[0]).toMatchObject({
			method: "POST",
			url: BASE,
			body: {
				name: "Mobile apps",
				repositoryIntegrationIds: ["int_web"],
			},
		});
	});

	it("updates with PATCH on the set, encoding its id", async () => {
		const { fabric, captured } = client();
		await fabric.projects.updateInstructionSet("proj_1", "set/1", {
			name: "Apps",
		});
		expect(captured[0]).toMatchObject({
			method: "PATCH",
			url: `${BASE}/set%2F1`,
			body: { name: "Apps" },
		});
	});

	it("deletes with DELETE and names the organization when asked", async () => {
		const { fabric, captured } = client({
			body: { data: { id: "set_1", deleted: true } },
		});
		await fabric.projects.deleteInstructionSet("proj_1", "set_1", {
			org: "example-org",
		});
		expect(captured[0]).toMatchObject({
			method: "DELETE",
			url: `${BASE}/set_1?org=example-org`,
		});
	});

	it("surfaces a refusal as an error with its status", async () => {
		const { fabric } = client({
			status: 409,
			body: { error: { message: "Taken.", code: "SLUG_TAKEN" } },
		});
		const error = await fabric.projects
			.createInstructionSet("proj_1", { name: "Web" })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(FabricError);
		expect(error).toMatchObject({ status: 409, code: "SLUG_TAKEN" });
	});
});
