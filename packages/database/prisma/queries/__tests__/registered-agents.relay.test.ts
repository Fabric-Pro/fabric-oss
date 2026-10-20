import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("../../client", () => ({ db: { registeredAgent: { findFirst } } }));

import { getActiveSystemRegisteredAgent } from "../registered-agents";

const rows = [
	{
		agentId: "system-agent",
		name: "system-name",
		scope: "SYSTEM",
		status: "ACTIVE",
		deploymentUrl: "https://agent.example.com",
	},
	{
		agentId: "user-agent",
		name: "user-name",
		scope: "USER",
		status: "ACTIVE",
		deploymentUrl: "https://user.example.com",
	},
	{
		agentId: "org-agent",
		name: "org-name",
		scope: "ORGANIZATION",
		status: "ACTIVE",
		deploymentUrl: "https://org.example.com",
	},
	{
		agentId: "inactive-agent",
		name: "inactive-name",
		scope: "SYSTEM",
		status: "INACTIVE",
		deploymentUrl: "https://inactive.example.com",
	},
];

beforeEach(() => {
	// Evaluate the query's filters against synthetic rows, without a database.
	findFirst.mockImplementation(async ({ where }) => {
		const row = rows.find(
			(row) =>
				(!where.scope || row.scope === where.scope) &&
				(!where.status || row.status === where.status) &&
				where.OR.some(
					(match: { agentId?: string; name?: string }) =>
						match.agentId === row.agentId ||
						match.name === row.name,
				),
		);
		return row ? { deploymentUrl: row.deploymentUrl } : null;
	});
});

describe("relay destination lookup", () => {
	it.each(["system-agent", "system-name"])(
		"resolves an ACTIVE SYSTEM agent by %s",
		async (id) => {
			await expect(getActiveSystemRegisteredAgent(id)).resolves.toEqual({
				deploymentUrl: "https://agent.example.com",
			});
		},
	);
	it.each([
		"unknown",
		"user-agent",
		"user-name",
		"org-agent",
		"org-name",
		"inactive-agent",
		"inactive-name",
	])("does not expose %s", async (id) => {
		await expect(getActiveSystemRegisteredAgent(id)).resolves.toBeNull();
	});
});
