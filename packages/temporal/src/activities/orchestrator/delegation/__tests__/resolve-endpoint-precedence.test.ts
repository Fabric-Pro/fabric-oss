import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentRow,
	agentRow,
	matchesAgentWhere,
} from "./registered-agent-fixtures";

const h = vi.hoisted(() => ({
	findMany: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { registeredAgent: { findMany: h.findMany } },
}));
vi.mock("../../../../lib/agent-url-resolver", () => ({
	resolveAgentUrl: (_id: string, url: string) => url,
}));

import { resolveAgentEndpoint } from "../resolve-endpoint";

let rows: AgentRow[];
const system = agentRow();
const org = agentRow({
	id: "example-org-row",
	agentId: "example-org-agent",
	scope: "ORGANIZATION",
	organizationId: "example-org",
	userId: "example-other-user",
	deploymentUrl: "https://member.example.com",
	metadata: { protocols: ["A2A"], tags: ["example-org-tag"] },
});
const own = agentRow({
	id: "example-user-row",
	agentId: "example-user-agent",
	scope: "USER",
	userId: "example-user",
});
const resolve = (key = system.name) =>
	resolveAgentEndpoint(key, "example-user", "example-org");

beforeEach(() => {
	vi.clearAllMocks();
	rows = [];

	h.findMany.mockImplementation(async ({ where }) =>
		rows.filter((row) => matchesAgentWhere(row, where)),
	);
});

describe("delegation lookup precedence", () => {
	it.each([
		{
			key: "Task Planner",
			agentId: "task_planner",
			name: "task_planner",
			displayName: "Task Planner",
		},
		{
			key: "CUGA_GENERALIST",
			agentId: "cuga_generalist",
			name: "cuga_generalist",
			displayName: "Example generalist",
		},
		{
			key: "  Task Planner  ",
			agentId: "task_planner",
			name: "task_planner",
			displayName: "Task Planner",
		},
		{
			key: "EXAMPLE-BUILT-IN",
			agentId: "example-built-in-agent",
			name: "example-built-in",
			displayName: "Example agent",
		},
	])(
		"resolves built-in names before member look-alikes: $key",
		async ({ key, ...identity }) => {
			const builtIn = { ...system, ...identity };
			const member = { ...org, name: key.trim() };
			for (const order of [
				[member, builtIn],
				[builtIn, member],
			]) {
				rows = order;
				expect(await resolve(key)).toMatchObject({
					agentId: builtIn.agentId,
					deploymentUrl: system.deploymentUrl,
				});
			}
		},
	);
	it.each([false, true])(
		"SYSTEM beats a colliding ORGANIZATION name (org first=%s)",
		async (orgFirst) => {
			rows = orgFirst ? [org, system] : [system, org];
			expect(await resolve()).toMatchObject({
				agentId: system.agentId,
				deploymentUrl: system.deploymentUrl,
				isExternal: false,
			});
		},
	);
	it.each([false, true])(
		"a STALE SYSTEM name blocks an ACTIVE ORGANIZATION endpoint (org first=%s)",
		async (orgFirst) => {
			const staleSystem = { ...system, status: "STALE" };
			rows = orgFirst ? [org, staleSystem] : [staleSystem, org];
			expect(await resolve()).toBeNull();
		},
	);
	it("a SYSTEM name beats a member exact agentId", async () => {
		rows = [system, { ...org, agentId: system.name }];
		expect(await resolve()).toMatchObject({
			agentId: system.agentId,
			isExternal: false,
		});
	});
	it("resolves a non-colliding ORGANIZATION agentId to its own row", async () => {
		rows = [system, org];
		expect(await resolve(org.agentId)).toMatchObject({
			agentId: org.agentId,
			isExternal: true,
		});
	});
	it("ranks SYSTEM exact ID, exact name, insensitive ID/name, then displayName before age", async () => {
		const ranked = [
			{
				...system,
				id: "example-exact-id-row",
				agentId: system.name,
				name: "example-exact-id-name",
				createdAt: new Date("2026-05-01"),
			},
			{ ...system, createdAt: new Date("2026-04-01") },
			{
				...system,
				id: "example-insensitive-name-row",
				agentId: "example-insensitive-name-agent",
				name: system.name.toUpperCase(),
				createdAt: new Date("2026-02-01"),
			},
			{
				...system,
				id: "example-insensitive-id-row",
				agentId: system.name.toUpperCase(),
				name: "example-insensitive-id-name",
				createdAt: new Date("2026-03-01"),
			},
			{
				...system,
				id: "example-display-row",
				agentId: "example-display-agent",
				name: "example-display-name",
				displayName: system.name,
			},
		];
		for (let index = 0; index < ranked.length; index++) {
			const remaining = ranked.slice(index);
			for (const order of [remaining, [...remaining].reverse()]) {
				rows = [org, ...order];
				expect(await resolve()).toHaveProperty(
					"agentId",
					ranked[index].agentId,
				);
				rows = rows.map((row) =>
					row.agentId === ranked[index].agentId
						? { ...row, status: "STALE" }
						: row,
				);
				expect(await resolve()).toBeNull();
			}
		}
	});

	it("the caller's USER row beats an ORGANIZATION name match", async () => {
		rows = [org, own];
		expect(await resolve()).toMatchObject({
			agentId: own.agentId,
			isExternal: true,
		});
	});
	it.each(["SYSTEM", "USER", "ORGANIZATION"])(
		"breaks %s ties by oldest createdAt then id in both row orders",
		async (scope) => {
			const base =
				scope === "SYSTEM" ? system : scope === "USER" ? own : org;
			const winner = {
				...base,
				id: "example-a",
				agentId: "example-oldest-a",
			};
			const others = [
				{ ...base, id: "example-z", agentId: "example-oldest-z" },
				{
					...base,
					id: "example-0",
					agentId: "example-newer",
					createdAt: new Date("2026-02-01"),
				},
			];
			for (const order of [
				[...others, winner],
				[...others, winner].reverse(),
			]) {
				rows = order;
				expect(await resolve()).toHaveProperty(
					"agentId",
					winner.agentId,
				);
			}
		},
	);
	it("filters out-of-tenant rows before ranking member names", async () => {
		const foreignRows = [
			{
				...own,
				id: "example-foreign-user-row",
				agentId: "example-foreign-user-agent",
				userId: "example-other-user",
			},
			{
				...org,
				id: "example-foreign-org-row",
				agentId: system.name,
				organizationId: "example-other-org",
			},
		];
		rows = [...foreignRows, org];
		expect(await resolve()).toHaveProperty("agentId", org.agentId);
		rows = foreignRows;
		expect(
			await resolveAgentEndpoint(system.name, "example-user"),
		).toBeNull();
	});

	it.each([
		{ key: "example_generalist", dbMatchedName: "exampleXgeneralist" },
		{
			key: "example%generalist",
			dbMatchedName: "example-other-generalist",
		},
	])(
		"rejects a DB-only SYSTEM match for $key before ranking",
		async ({ key, dbMatchedName }) => {
			// Model a database match broader than the JS names predicate.
			h.findMany.mockResolvedValue([
				{ ...system, name: dbMatchedName },
				{ ...org, name: key },
			]);
			expect(await resolve(key)).toHaveProperty("agentId", org.agentId);
		},
	);

	it("keeps the A2A protocol requirement on the winning self row", async () => {
		const warn = vi.spyOn(console, "warn");
		rows = [
			{ ...org, name: "fabric" },
			{
				...system,
				agentId: "fabric-workspace-assistant",
				name: "example-self",
				displayName: "Fabric",
				metadata: { protocols: ["HTTP"] },
			},
		];
		expect(await resolve("fabric")).toBeNull();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("does not support A2A"),
			{ scope: "SYSTEM", status: "ACTIVE" },
		);
		warn.mockRestore();
	});

	it("returns null for an unknown key", async () => {
		rows = [system, org];
		expect(await resolve("example-missing")).toBeNull();
	});
});
