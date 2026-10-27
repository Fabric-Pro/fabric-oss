import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../prisma/generated/client";
import {
	createOrganizationContext,
	grantProjectAccess,
	runWithTenantContext,
} from "../src/tenant-context";
import { createTenantDbClient, mergeWithTenantFilter } from "../src/tenant-db";

type Where = Record<string, unknown>;
type Operation = (input: {
	model: string;
	operation: string;
	args: { where: Where };
	query: (args: { where: Where }) => Promise<unknown>;
}) => Promise<unknown>;

// Capture the extension callback and inspect the arguments sent to Prisma.
function extensionFor(): Operation {
	const base = {
		$executeRaw: async () => 1,
		$transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
		$extends: (config: {
			query: { $allModels: { $allOperations: Operation } };
		}) => config.query.$allModels.$allOperations,
	};
	return createTenantDbClient(
		base as unknown as PrismaClient,
	) as unknown as Operation;
}

const owner = { userId: "example-user", organizationId: "example-org" };
const scopeFilter = (scope: string) => ({
	OR: [{ scope: "SYSTEM" }, { scope, organizationId: "example-org" }],
});
const cases = [
	{ model: "AiChat", read: owner, write: owner },
	{
		model: "AgentConversation",
		read: {
			OR: [
				owner,
				{ organizationId: "example-org", visibility: "ORGANIZATION" },
			],
		},
		write: owner,
	},
	{
		model: "Project",
		grant: true,
		read: {
			OR: [
				{ organizationId: "example-org" },
				{ id: { in: ["example-project"] } },
			],
		},
		write: {
			OR: [
				{ organizationId: "example-org" },
				{ id: { in: ["example-project"] } },
			],
		},
	},
	{
		model: "UserStory",
		grant: true,
		read: { projectId: { in: ["example-project"] } },
		write: { projectId: { in: ["example-project"] } },
	},
	...[
		["RegisteredAgent", "ORGANIZATION"],
		["Prompt", "ORG"],
		["ReportTemplate", "ORGANIZATION"],
		["DynamicAgentConfig", "ORGANIZATION"],
	].map(([model, scope]) => ({
		model,
		read: scopeFilter(scope),
		write: scopeFilter(scope),
	})),
];

const andForms = [
	{ name: "absent AND", where: { id: "example-row" }, clauses: [] },
	{
		name: "object AND",
		where: { id: "example-row", AND: { title: "Example" } },
		clauses: [{ title: "Example" }],
	},
	{
		name: "array AND",
		where: {
			id: "example-row",
			AND: [{ title: "Example" }, { NOT: { id: "example-excluded" } }],
		},
		clauses: [{ title: "Example" }, { NOT: { id: "example-excluded" } }],
	},
];

describe.each(["findUnique", "findUniqueOrThrow", "update", "delete"])(
	"%s unique where",
	(operation) => {
		for (const testCase of cases) {
			it.each(andForms)(
				`${testCase.model} preserves top-level selectors and $name`,
				async ({ where, clauses }) => {
					const caller = {
						...where,
						OR: [{ id: "example-row" }, { id: "example-other" }],
					};
					const original = structuredClone(caller);
					const filter = operation.startsWith("find")
						? testCase.read
						: testCase.write;
					const sent = await runWithTenantContext(
						createOrganizationContext(
							"example-org",
							"example-user",
						),
						() => {
							if ("grant" in testCase && testCase.grant) {
								grantProjectAccess("example-project");
							}
							return extensionFor()({
								model: testCase.model,
								operation,
								args: { where: caller },
								query: async (args) => args.where,
							});
						},
					);
					expect(sent).toEqual({
						...caller,
						AND: [...clauses, filter],
					});
					expect(caller).toEqual(original);
				},
			);
		}

		it.each(["User", "UserStory"])(
			"leaves %s where unchanged when there is no filter",
			async (model) => {
				const where = { id: "example-row", AND: { id: "example-row" } };
				const sent = await runWithTenantContext(
					createOrganizationContext("example-org", "example-user"),
					() =>
						extensionFor()({
							model,
							operation,
							args: { where },
							query: async (args) => args.where,
						}),
				);
				expect(sent).toBe(where);
			},
		);
	},
);

it.each(["RegisteredAgent", "Prompt", "ReportTemplate", "DynamicAgentConfig"])(
	"%s scope merge preserves the caller's OR",
	(model) => {
		const where = { OR: [{ id: "example-row" }, { id: "example-other" }] };
		const result = runWithTenantContext(
			createOrganizationContext("example-org", "example-user"),
			() => mergeWithTenantFilter(model, where),
		);
		expect(result).toEqual({
			AND: [
				where,
				scopeFilter(model === "Prompt" ? "ORG" : "ORGANIZATION"),
			],
		});
	},
);
