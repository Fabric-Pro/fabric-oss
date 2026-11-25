import { expect, it, vi } from "vitest";
import type { PrismaClient } from "../prisma/generated/client";
import {
	createOrganizationContext,
	grantProjectAccess,
	runWithTenantContext,
} from "../src/tenant-context";
import { createTenantDbClient } from "../src/tenant-db";

type Arguments = {
	select?: Record<string, boolean>;
	where?: Record<string, unknown>;
	data?: Record<string, unknown>;
};
type Operation = (call: {
	model: string;
	operation: string;
	args: Arguments;
	query: (args: Arguments) => Promise<unknown>;
}) => Promise<unknown>;

function setup() {
	const executeRaw = vi.fn().mockResolvedValue(1);
	const transaction = vi.fn((queries: Promise<unknown>[]) =>
		Promise.all(queries),
	);
	const base = {
		$executeRaw: executeRaw,
		$transaction: transaction,
		$extends: (config: {
			query: { $allModels: { $allOperations: Operation } };
		}) => config.query.$allModels.$allOperations,
	};
	return {
		run: createTenantDbClient(
			base as unknown as PrismaClient,
		) as unknown as Operation,
		executeRaw,
		transaction,
	};
}

const organizationId = "example-org";
const userId = "example-user";
const projectId = "invited-project";

it("constrains parent-scoped bulk writes to the active organization and explicitly invited project", async () => {
	const { run, executeRaw, transaction } = setup();
	const query = vi.fn().mockResolvedValue({ count: 1 });
	const where = { id: "example-approver" };
	const result = await runWithTenantContext(
		createOrganizationContext(organizationId, userId),
		() => {
			grantProjectAccess(projectId, "other-org");
			return run({
				model: "ProjectStageApprover",
				operation: "deleteMany",
				args: { where },
				query,
			});
		},
	);
	expect(result).toEqual({ count: 1 });
	expect(query).toHaveBeenCalledExactlyOnceWith({
		where: {
			AND: [
				where,
				{
					OR: [
						{ project: { organizationId } },
						{ projectId: { in: [projectId] } },
					],
				},
			],
		},
	});
	expect(executeRaw.mock.calls[0]?.slice(1)).toEqual([
		"organization",
		organizationId,
		userId,
	]);
	expect(transaction).toHaveBeenCalledOnce();
});

it("passes create data through with RLS context in the same batch", async () => {
	const { run, executeRaw, transaction } = setup();
	const data = { organizationId, userId, name: "Example Project" };
	const result = { id: "example-project" };
	const args = { data, select: { id: true } };
	const query = vi.fn().mockResolvedValue(result);
	await expect(
		runWithTenantContext(
			createOrganizationContext(organizationId, userId),
			() =>
				run({
					model: "Project",
					operation: "create",
					args,
					query,
				}),
		),
	).resolves.toBe(result);
	expect(query).toHaveBeenCalledExactlyOnceWith(args);
	expect(executeRaw.mock.calls[0]?.slice(1)).toEqual([
		"organization",
		organizationId,
		userId,
	]);
	expect(transaction).toHaveBeenCalledExactlyOnceWith([
		executeRaw.mock.results[0]?.value,
		query.mock.results[0]?.value,
	]);
});

it("does not install RLS settings when called without a tenant context", async () => {
	const { run, executeRaw, transaction } = setup();
	const args = {
		data: { organizationId, userId, name: "Example Project" },
		select: { id: true },
	};
	const query = vi.fn().mockResolvedValue({ id: "example-project" });
	await expect(
		run({ model: "Project", operation: "create", args, query }),
	).resolves.toEqual({ id: "example-project" });
	expect(query).toHaveBeenCalledExactlyOnceWith(args);
	expect(executeRaw).not.toHaveBeenCalled();
	expect(transaction).not.toHaveBeenCalled();
});
