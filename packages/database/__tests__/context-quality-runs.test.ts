import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../prisma/client";
import {
	type AdmitContextQualityRunInput,
	admitContextQualityRun,
	contextQualityBindingSnapshot,
	deleteSettledContextQualityRunsForOrganizationInTransaction,
	deleteSettledContextQualityRunsForProject,
	disableContextQualityBinding,
	findContextQualityRunsForRecovery,
	getContextQualityBinding,
	getContextQualityRunForWorker,
	getContextQualityRunSummary,
	listContextQualityRunSummaries,
	purgeContextQualityRunSnapshot,
	purgeSettledContextQualityRunSnapshot,
	requestContextQualityRunCancellation,
	saveContextQualityBinding,
	transitionContextQualityRun,
} from "../prisma/queries/projects/context-quality-runs";
import {
	createOrganizationContext,
	runWithTenantContext,
} from "../src/tenant-context";

const fake = vi.hoisted(() => ({ current: {} as unknown }));
vi.mock("../prisma/client", async (importOriginal) => {
	const original = await importOriginal<typeof import("../prisma/client")>();
	return {
		...original,
		get db() {
			return fake.current as typeof original.db;
		},
	};
});

type Row = Record<string, unknown>;
const scope = { organizationId: "example-org", projectId: "example-project" };
const runScope = { ...scope, runId: "example-run" };
const sha = (value: string) =>
	createHash("sha256").update(value, "utf8").digest("hex");
const configHash = sha("example-binding");
const snapshotHash = sha("example-snapshot");
const revision = sha("Example source");
const report = {
	version: 1,
	mode: "recorded-output",
	scorerVersion: "fabric-deterministic-context-v1",
	datasetHash: sha("example-dataset"),
	configurationHash: sha("example-scorer-configuration"),
	snapshotHash,
	status: "failed",
	counts: {
		cases: 1,
		passed: 0,
		failed: 1,
		integrityFailures: 1,
		qualityFailures: 0,
	},
	sources: [{ id: "example-source", revision }],
	cases: [
		{
			id: "example-case",
			status: "failed",
			checks: [
				{
					id: "recorded-answer-present",
					category: "integrity",
					status: "failed",
				},
			],
			retrieval: { precision: null, recall: null },
			citations: { precision: null, recall: null },
		},
	],
};
const bindingInput = {
	...scope,
	actorId: "example-user",
	integrationId: "example-integration",
	workspaceOrigin: "https://example.com",
	jobId: "12",
	experimentId: "34",
	volumeRoot: "/Volumes/example_catalog/example_schema/example_volume",
	notebookPath: "/Shared/example-notebook",
	notebookSha256: sha("example-notebook"),
	principalFingerprint: sha("example-principal"),
	configHash,
	isEnabled: true,
	exportApproved: true,
};
function admission(
	overrides: Partial<AdmitContextQualityRunInput> = {},
): AdmitContextQualityRunInput {
	// Deliberately preserve whitespace and multibyte text, not reserialized JSON.
	const snapshotPayload =
		'{ "version": 1, "private": "Example source 🌱" }\n';
	return {
		...scope,
		id: runScope.runId,
		requestedBy: "example-user",
		name: "Example evaluation",
		idempotencyKey: "example-request",
		requestHash: sha("example-request"),
		bindingId: "example-binding",
		bindingConfigHash: configHash,
		sourceRefsJson: [
			{ sourceId: "example-source", expectedRevision: revision },
		],
		snapshotPayload,
		payloadHash: sha(snapshotPayload),
		snapshotHash,
		scorerVersion: report.scorerVersion,
		localResultJson: structuredClone(report),
		workflowId: "example-workflow",
		dispatchToken: "example-dispatch",
		deadlineAt: new Date(Date.now() + 60_000),
		snapshotExpiresAt: new Date(Date.now() + 120_000),
		...overrides,
	};
}

// Generic predicate/selection fake. It does not implement admission, lifecycle,
// cancellation, cleanup or authorization rules; all of those run in the queries.
function matches(row: Row, where: Row = {}): boolean {
	return Object.entries(where).every(([key, condition]) => {
		if (condition === undefined) return true;
		if (key === "OR" || key === "AND") {
			const results = (condition as Row[]).map((part) =>
				matches(row, part),
			);
			return key === "OR"
				? results.some(Boolean)
				: results.every(Boolean);
		}
		const actual = row[key];
		if (
			condition &&
			typeof condition === "object" &&
			!(condition instanceof Date)
		) {
			return Object.entries(condition).every(([operator, expected]) => {
				switch (operator) {
					case "in":
						return (expected as unknown[]).includes(actual);
					case "notIn":
						return !(expected as unknown[]).includes(actual);
					case "not":
						return (
							actual !== expected &&
							!(actual === null && expected === Prisma.DbNull)
						);
					case "lt":
						return (actual as number) < (expected as number);
					case "lte":
						return (actual as number) <= (expected as number);
					default:
						throw new Error(
							`Unsupported fake operator ${operator}`,
						);
				}
			});
		}
		return actual instanceof Date && condition instanceof Date
			? actual.getTime() === condition.getTime()
			: actual === condition;
	});
}
function project(row: Row, select?: Record<string, boolean>): Row {
	return structuredClone(
		select
			? Object.fromEntries(
					Object.entries(row).filter(([key]) => select[key]),
				)
			: row,
	);
}
function table(rows: Row[], defaults: Row = {}) {
	const find = (where?: Row) => rows.find((row) => matches(row, where));
	const apply = (row: Row, data: Row) => {
		for (const [key, value] of Object.entries(data)) {
			if (value !== undefined)
				row[key] =
					value && typeof value === "object" && "increment" in value
						? Number(row[key]) + Number(value.increment)
						: structuredClone(value);
		}
	};
	return {
		findFirst: vi.fn(
			async ({
				where,
				select,
			}: {
				where?: Row;
				select?: Record<string, boolean>;
			}) => {
				const row = find(where);
				return row ? project(row, select) : null;
			},
		),
		findMany: vi.fn(
			async ({
				where,
				select,
				orderBy,
				take,
			}: {
				where?: Row;
				select?: Record<string, boolean>;
				orderBy?: Row | Row[];
				take?: number;
			}) => {
				const ordering = orderBy
					? Array.isArray(orderBy)
						? orderBy
						: [orderBy]
					: [];
				return rows
					.filter((row) => matches(row, where))
					.sort((a, b) => {
						for (const term of ordering) {
							for (const [key, direction] of Object.entries(
								term,
							)) {
								const left =
									a[key] instanceof Date
										? a[key].getTime()
										: a[key];
								const right =
									b[key] instanceof Date
										? b[key].getTime()
										: b[key];
								if (left === right) continue;
								const comparison =
									(left as number) < (right as number)
										? -1
										: 1;
								return direction === "asc"
									? comparison
									: -comparison;
							}
						}
						return 0;
					})
					.slice(0, take)
					.map((row) => project(row, select));
			},
		),
		create: vi.fn(
			async ({
				data,
				select,
			}: {
				data: Row;
				select?: Record<string, boolean>;
			}) => {
				const row = structuredClone({ ...defaults, ...data });
				rows.push(row);
				return project(row, select);
			},
		),
		createMany: vi.fn(async ({ data }: { data: Row[] }) => {
			rows.push(...structuredClone(data));
			return { count: data.length };
		}),
		upsert: vi.fn(
			async ({
				where,
				create,
				update,
			}: {
				where: Row;
				create: Row;
				update: Row;
			}) => {
				const row = find(where);
				if (row) {
					apply(row, update);
					return project(row);
				}
				const created = structuredClone({ ...defaults, ...create });
				rows.push(created);
				return project(created);
			},
		),
		updateMany: vi.fn(
			async ({ where, data }: { where: Row; data: Row }) => {
				const selected = rows.filter((row) => matches(row, where));
				selected.forEach((row) => apply(row, data));
				return { count: selected.length };
			},
		),
		count: vi.fn(
			async ({ where }: { where: Row }) =>
				rows.filter((row) => matches(row, where)).length,
		),
		deleteMany: vi.fn(async ({ where }: { where: Row }) => {
			let count = 0;
			for (let i = rows.length - 1; i >= 0; i--)
				if (matches(rows[i]!, where)) {
					rows.splice(i, 1);
					count++;
				}
			return { count };
		}),
	};
}
function makeStore() {
	const binding = {
		...bindingInput,
		id: "example-binding",
		configVersion: 1,
		exportApprovedAt: new Date(),
		exportApprovedBy: "example-user",
	};
	const bindings: Row[] = [binding];
	const runs: Row[] = [];
	const principals: Row[] = [];
	const integrations: Row[] = [
		{
			id: bindingInput.integrationId,
			organizationId: scope.organizationId,
			userId: "example-owner",
			provider: "DATABRICKS_PLATFORM",
			workflowId: null,
			isActive: true,
			usageScope: "ORGANIZATION_SHARED",
		},
	];
	const members: Row[] = [
		{
			id: "example-member",
			organizationId: scope.organizationId,
			userId: "example-owner",
		},
	];
	const client = {
		$executeRaw: vi.fn(async () => 1),
		$executeRawUnsafe: vi.fn(async () => 1),
		project: table([
			{
				id: scope.projectId,
				organizationId: scope.organizationId,
				deletedAt: null,
			},
		]),
		workflowIntegration: table(integrations),
		member: table(members),
		projectContextQualityBinding: table(bindings, {
			id: "example-binding",
			configVersion: 1,
		}),
		projectContextQualityPrincipal: table(principals),
		projectContextQualityRun: table(runs, {
			status: "QUEUED",
			stateVersion: 0,
			remoteRunId: null,
			remoteMlflowRunId: null,
			remoteState: null,
			providerReceiptJson: null,
			resultJson: null,
			remoteInputPath: null,
			errorCode: null,
			cleanupStatus: "NOT_REQUIRED",
			cleanupErrorCode: null,
			cancelRequestedAt: null,
			startedAt: null,
			completedAt: null,
			snapshotPurgedAt: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		}),
		$transaction: vi.fn(
			async (callback: (tx: unknown) => Promise<unknown>) =>
				callback(client),
		),
	};
	return {
		client,
		binding,
		bindings,
		runs,
		principals,
		integrations,
		members,
	};
}
let store: ReturnType<typeof makeStore>;
beforeEach(() => {
	store = makeStore();
	fake.current = store.client;
});

async function seedRun(changes: Row = {}) {
	await admitContextQualityRun(admission());
	Object.assign(store.runs[0]!, changes);
	return store.runs[0]!;
}
const change = (
	patch: Parameters<typeof transitionContextQualityRun>[0]["patch"],
	expectedStateVersion = 0,
	fromStatuses: Parameters<
		typeof transitionContextQualityRun
	>[0]["fromStatuses"] = ["QUEUED"],
) =>
	transitionContextQualityRun({
		...runScope,
		patch,
		expectedStateVersion,
		fromStatuses,
	});

describe("context quality binding ownership", () => {
	it("installs request-local RLS settings on the same transaction as the read", async () => {
		await runWithTenantContext(
			createOrganizationContext(scope.organizationId, "example-user"),
			() => getContextQualityBinding(scope),
		);
		expect(store.client.$executeRawUnsafe).toHaveBeenCalledWith(
			"SELECT set_config('app.tenant_type', $1, true)",
			"organization",
		);
		expect(store.client.$executeRawUnsafe).toHaveBeenCalledWith(
			"SELECT set_config('app.tenant_id', $1, true)",
			scope.organizationId,
		);
		expect(store.client.$executeRawUnsafe).toHaveBeenCalledWith(
			"SELECT set_config('app.user_id', $1, true)",
			"example-user",
		);
	});
	it("requires the exact project's organization, not just a binding id", async () => {
		await expect(
			saveContextQualityBinding({
				...bindingInput,
				organizationId: "example-other-org",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(
			store.client.projectContextQualityBinding.upsert,
		).not.toHaveBeenCalled();
	});
	it.each([
		{ organizationId: "example-other-org" },
		{ provider: "DATABRICKS_SQL" },
		{ workflowId: "example-workflow" },
		{ isActive: false },
		{ usageScope: "OWNER_ONLY" },
	])(
		"rejects an integration outside the active shared platform contract: %j",
		async (changes) => {
			Object.assign(store.integrations[0]!, changes);
			await expect(
				saveContextQualityBinding(bindingInput),
			).rejects.toMatchObject({ code: "INVALID_BINDING" });
			expect(
				store.client.projectContextQualityBinding.upsert,
			).not.toHaveBeenCalled();
		},
	);
	it("requires the integration owner's current organization membership", async () => {
		store.members.length = 0;
		await expect(
			saveContextQualityBinding(bindingInput),
		).rejects.toMatchObject({ code: "INVALID_BINDING" });
	});
	it("claims a principal without a cross-organization lookup and refuses an invisible conflicting claim", async () => {
		store.client.projectContextQualityPrincipal.createMany.mockResolvedValueOnce(
			{ count: 0 },
		);
		await expect(
			saveContextQualityBinding(bindingInput),
		).rejects.toMatchObject({ code: "INVALID_BINDING" });
		expect(
			store.client.projectContextQualityPrincipal.createMany,
		).toHaveBeenCalledWith({
			data: [
				{
					fingerprint: bindingInput.principalFingerprint,
					organizationId: scope.organizationId,
				},
			],
			skipDuplicates: true,
		});
		expect(
			store.client.projectContextQualityPrincipal.findFirst,
		).toHaveBeenCalledWith({
			where: {
				fingerprint: bindingInput.principalFingerprint,
				organizationId: scope.organizationId,
			},
			select: { fingerprint: true },
		});
		expect(
			store.client.projectContextQualityBinding.upsert,
		).not.toHaveBeenCalled();
	});
	it("preserves an unchanged approval, fences stale configuration, and increments changed versions", async () => {
		const saved = await saveContextQualityBinding(bindingInput);
		expect(saved.configVersion).toBe(1);
		expect(
			store.client.projectContextQualityBinding.upsert,
		).not.toHaveBeenCalled();
		await expect(
			saveContextQualityBinding({
				...bindingInput,
				expectedConfigHash: sha("stale"),
			}),
		).rejects.toMatchObject({ code: "BINDING_CHANGED" });
		await expect(
			saveContextQualityBinding({ ...bindingInput, jobId: "99" }),
		).rejects.toMatchObject({ code: "BINDING_CHANGED" });
		const changed = await saveContextQualityBinding({
			...bindingInput,
			configHash: sha("changed"),
			isEnabled: false,
		});
		expect(changed.configVersion).toBe(2);
		expect(
			store.client.projectContextQualityBinding.upsert.mock.calls[0]?.[0]
				.where,
		).toEqual({
			projectId: scope.projectId,
			organizationId: scope.organizationId,
		});
	});
	it("does not release resources or their integration FK while frozen receipts still need cleanup", async () => {
		await seedRun({
			status: "FAILED",
			cleanupStatus: "BLOCKED",
			remoteRunId: "56",
		});
		await expect(
			saveContextQualityBinding({
				...bindingInput,
				jobId: "99",
				configHash: sha("new-resources"),
			}),
		).rejects.toMatchObject({ code: "BINDING_CHANGED" });
		const disabled = await saveContextQualityBinding({
			...bindingInput,
			isEnabled: false,
		});
		expect(disabled.isEnabled).toBe(false);
		expect(disabled.integrationId).toBe(bindingInput.integrationId);
		store.runs[0]!.cleanupStatus = "CONFIRMED";
		expect(
			await saveContextQualityBinding({
				...bindingInput,
				jobId: "99",
				configHash: sha("new-resources"),
			}),
		).toMatchObject({ jobId: "99" });
	});
	it("refuses cross-project resource collisions without disclosing constraint diagnostics", async () => {
		store.client.projectContextQualityBinding.upsert.mockRejectedValueOnce(
			Object.assign(new Error("Example other project diagnostics"), {
				code: "P2002",
			}),
		);
		await expect(
			saveContextQualityBinding({
				...bindingInput,
				jobId: "99",
				configHash: sha("changed"),
			}),
		).rejects.toMatchObject({ code: "INVALID_BINDING" });
	});
	it("does not freeze extra binding properties such as integration credentials", () => {
		expect(
			contextQualityBindingSnapshot({
				...store.binding,
				credentials: "example-private",
			} as typeof store.binding),
		).not.toHaveProperty("credentials");
	});
});

describe("immutable private admission", () => {
	it("stores exact UTF-8 payload bytes and a separate safe local result, never in summaries", async () => {
		const input = admission();
		const admitted = await admitContextQualityRun(input);
		expect(store.runs[0]?.snapshotPayload).toBe(input.snapshotPayload);
		expect(store.runs[0]?.payloadHash).toBe(sha(input.snapshotPayload));
		expect(store.runs[0]?.localResultJson).toEqual(report);
		const summaries = [
			admitted.run,
			await getContextQualityRunSummary(runScope),
			...(await listContextQualityRunSummaries(scope)).runs,
		];
		for (const summary of summaries) {
			expect(summary).not.toHaveProperty("snapshotPayload");
			expect(summary).not.toHaveProperty("localResultJson");
			expect(summary).not.toHaveProperty("bindingConfigJson");
			expect(summary).not.toHaveProperty("dispatchToken");
			expect(summary).not.toHaveProperty("providerReceiptJson");
			expect(JSON.stringify(summary)).not.toContain("Example source");
		}
		expect(
			(await getContextQualityRunForWorker(runScope))?.snapshotPayload,
		).toBe(input.snapshotPayload);
	});
	it("reuses the actor's key after expiry without rewriting immutable data and refuses hash collisions", async () => {
		const input = admission();
		await admitContextQualityRun(input);
		const retry = await admitContextQualityRun({
			...input,
			id: "example-retry",
			deadlineAt: new Date(0),
		});
		expect(retry).toMatchObject({ created: false, run: { id: input.id } });
		await expect(
			admitContextQualityRun({
				...input,
				requestHash: sha("other-request"),
			}),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		expect(store.runs).toHaveLength(1);
		expect(store.runs[0]?.snapshotPayload).toBe(input.snapshotPayload);
	});
	it.each([true, false])(
		"reconciles a unique-key admission race only when the winning request hash matches (%s)",
		async (sameRequest) => {
			const create =
				store.client.projectContextQualityRun.create.getMockImplementation()!;
			store.client.projectContextQualityRun.create.mockImplementationOnce(
				async ({ data, select }) => {
					await create({
						data: {
							...data,
							id: "example-winner",
							requestHash: sameRequest
								? data.requestHash
								: sha("other-request"),
						},
						select,
					});
					throw Object.assign(
						new Error("Example uniqueness conflict"),
						{ code: "P2002" },
					);
				},
			);
			const admitted = admitContextQualityRun(admission());
			if (sameRequest)
				await expect(admitted).resolves.toMatchObject({
					created: false,
					run: { id: "example-winner" },
				});
			else
				await expect(admitted).rejects.toMatchObject({
					code: "IDEMPOTENCY_CONFLICT",
				});
		},
	);
	it("does not propagate private create arguments through database error diagnostics", async () => {
		store.client.projectContextQualityRun.create.mockRejectedValueOnce(
			new Error(`Example create failure: ${admission().snapshotPayload}`),
		);
		let caught: unknown;
		try {
			await admitContextQualityRun(admission());
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toBe(
			"Context evaluation persistence request could not be completed.",
		);
		expect(caught).not.toHaveProperty("cause");
	});
	it("refuses a binding from another project even in the same organization", async () => {
		store.bindings[0]!.projectId = "example-other-project";
		await expect(admitContextQualityRun(admission())).rejects.toMatchObject(
			{ code: "INVALID_BINDING" },
		);
		expect(store.runs).toHaveLength(0);
	});
	it("revalidates sharing and membership at admission rather than trusting a saved binding", async () => {
		store.integrations[0]!.usageScope = "OWNER_ONLY";
		await expect(admitContextQualityRun(admission())).rejects.toMatchObject(
			{ code: "INVALID_BINDING" },
		);
	});
	it.each([
		[
			"mismatched payload hash",
			{ snapshotPayload: "changed without hash" },
		],
		[
			"UTF-8 byte overflow",
			{
				snapshotPayload: "🌱".repeat(40_000),
				payloadHash: sha("🌱".repeat(40_000)),
			},
		],
		[
			"content in a report",
			{
				localResultJson: {
					...report,
					recordedAnswer: "private recorded answer",
				},
			},
		],
		[
			"wrong report snapshot",
			{
				localResultJson: {
					...report,
					snapshotHash: sha("wrong-snapshot"),
				},
			},
		],
	] satisfies [string, Partial<AdmitContextQualityRunInput>][])(
		"refuses %s",
		async (_label, changes) => {
			await expect(
				admitContextQualityRun(admission(changes)),
			).rejects.toMatchObject({ code: "INVALID_INPUT" });
			expect(store.runs).toHaveLength(0);
		},
	);
	it("does not read or mutate a run through another organization or project", async () => {
		await seedRun({ snapshotExpiresAt: new Date(0) });
		for (const changed of [
			{ organizationId: "example-other-org" },
			{ projectId: "example-other-project" },
		]) {
			expect(
				await getContextQualityRunForWorker({
					...runScope,
					...changed,
				}),
			).toBeNull();
			expect(
				await getContextQualityRunSummary({ ...runScope, ...changed }),
			).toBeNull();
			expect(
				await getContextQualityBinding({ ...scope, ...changed }),
			).toBeNull();
			expect(
				(await listContextQualityRunSummaries({ ...scope, ...changed }))
					.runs,
			).toEqual([]);
			expect(
				await transitionContextQualityRun({
					...runScope,
					...changed,
					expectedStateVersion: 0,
					fromStatuses: ["QUEUED"],
					patch: { remoteState: "PENDING" },
				}),
			).toMatchObject({ updated: false });
			expect(
				await requestContextQualityRunCancellation({
					...runScope,
					...changed,
				}),
			).toBeNull();
			expect(
				await purgeContextQualityRunSnapshot({
					...runScope,
					...changed,
				}),
			).toBe(0);
		}
		expect(store.runs[0]?.stateVersion).toBe(0);
	});
	it("paginates a stable createdAt/id tie without repeating or skipping runs", async () => {
		await seedRun();
		const base = store.runs[0]!;
		store.runs.push(
			{ ...base, id: "example-run-a" },
			{ ...base, id: "example-run-z" },
		);
		const first = await listContextQualityRunSummaries({
			...scope,
			limit: 1,
		});
		const second = await listContextQualityRunSummaries({
			...scope,
			limit: 1,
			cursor: first.nextCursor!,
		});
		const third = await listContextQualityRunSummaries({
			...scope,
			limit: 1,
			cursor: second.nextCursor!,
		});
		expect([
			first.runs[0]?.id,
			second.runs[0]?.id,
			third.runs[0]?.id,
		]).toEqual(["example-run-z", "example-run-a", "example-run"]);
		expect(third.nextCursor).toBeNull();
	});
});

describe("run CAS, cancellation and frozen receipts", () => {
	it("rejects arbitrary lifecycle jumps and immutable payload patching", async () => {
		await seedRun();
		await expect(
			change({ status: "SUCCEEDED", completedAt: new Date() }),
		).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
		await expect(
			change({ snapshotPayload: "replacement" } as unknown as Parameters<
				typeof change
			>[0]),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(
			change({ cleanupStatus: "FAILED" } as unknown as Parameters<
				typeof change
			>[0]),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(store.runs[0]?.stateVersion).toBe(0);
	});
	it("makes cancellation idempotent and fences a delayed success while retaining a late native receipt", async () => {
		await seedRun({
			status: "RUNNING",
			remoteRunId: null,
			cleanupStatus: "PENDING",
		});
		const cancelled = await requestContextQualityRunCancellation(runScope);
		const twice = await requestContextQualityRunCancellation(runScope);
		expect(cancelled).toMatchObject({
			status: "CANCEL_REQUESTED",
			stateVersion: 1,
		});
		expect(twice?.cancelRequestedAt).toEqual(cancelled?.cancelRequestedAt);
		expect(twice?.stateVersion).toBe(1);
		expect(
			await change({ status: "SUCCEEDED", completedAt: new Date() }, 0, [
				"RUNNING",
			]),
		).toMatchObject({
			updated: false,
			run: { status: "CANCEL_REQUESTED" },
		});
		expect(
			await change({ remoteRunId: "56" }, 1, ["CANCEL_REQUESTED"]),
		).toMatchObject({
			updated: true,
			run: {
				status: "CANCEL_REQUESTED",
				remoteRunId: "56",
				stateVersion: 2,
			},
		});
		await expect(
			change({ remoteRunId: "57" }, 2, ["CANCEL_REQUESTED"]),
		).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
	});
	it("retains receipt mismatch detection even for stale activity versions", async () => {
		await seedRun({
			status: "RUNNING",
			stateVersion: 2,
			remoteRunId: "56",
		});
		await expect(
			change({ remoteRunId: "57" }, 0, ["RUNNING"]),
		).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
	});
	it("does not permit replacing an already frozen provider receipt", async () => {
		const receipt = {
			version: 1,
			fabricRunId: runScope.runId,
			payloadHash: admission().payloadHash,
			experimentId: "34",
			mlflowRunId: "a".repeat(32),
		};
		await seedRun({
			status: "RUNNING",
			remoteRunId: "56",
			remoteMlflowRunId: receipt.mlflowRunId,
			providerReceiptJson: receipt,
		});
		await expect(
			change(
				{
					providerReceiptJson: {
						...receipt,
						payloadHash: sha("other-payload"),
					},
				},
				0,
				["RUNNING"],
			),
		).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
		expect(store.runs[0]?.providerReceiptJson).toEqual(receipt);
	});
	it("pins the exact input path and marks cleanup pending before an upload can happen", async () => {
		await seedRun();
		await expect(
			change({
				status: "EXPORTING",
				remoteInputPath: `${bindingInput.volumeRoot}/example-other-run.json`,
			}),
		).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
		expect(
			await change({
				status: "EXPORTING",
				remoteInputPath: `${bindingInput.volumeRoot}/${runScope.runId}.json`,
			}),
		).toMatchObject({ updated: true, run: { cleanupStatus: "PENDING" } });
		await expect(
			change({ cleanupStatus: "NOT_REQUIRED" }, 1, ["EXPORTING"]),
		).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
	});
	it("records a new cleanup obligation when an unfinished immutable export is retried after erasure", async () => {
		const remoteInputPath = `${bindingInput.volumeRoot}/${runScope.runId}.json`;
		await seedRun({
			status: "RECONCILIATION_REQUIRED",
			cleanupStatus: "CONFIRMED",
			remoteInputPath,
		});
		expect(
			await change(
				{
					status: "EXPORTING",
					cleanupStatus: "PENDING",
					remoteInputPath,
				},
				0,
				["RECONCILIATION_REQUIRED"],
			),
		).toMatchObject({
			updated: true,
			run: {
				status: "EXPORTING",
				cleanupStatus: "PENDING",
				remoteInputPath,
			},
		});
	});
	it("keeps check failure independent of successful execution and freezes the terminal result", async () => {
		await seedRun({
			status: "RUNNING",
			remoteRunId: "56",
			cleanupStatus: "PENDING",
		});
		const receipt = {
			version: 1,
			fabricRunId: runScope.runId,
			payloadHash: admission().payloadHash,
			experimentId: "34",
			mlflowRunId: "a".repeat(32),
		};
		await expect(
			change(
				{
					providerReceiptJson: {
						...receipt,
						fabricRunId: "example-wrong-run",
					},
					remoteMlflowRunId: receipt.mlflowRunId,
				},
				0,
				["RUNNING"],
			),
		).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
		await expect(
			change(
				{
					status: "SUCCEEDED",
					resultJson: {
						...report,
						datasetHash: sha("different-result"),
					},
					remoteMlflowRunId: receipt.mlflowRunId,
					providerReceiptJson: receipt,
					completedAt: new Date(),
				},
				0,
				["RUNNING"],
			),
		).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
		expect(
			await change(
				{
					status: "SUCCEEDED",
					resultJson: report,
					remoteMlflowRunId: receipt.mlflowRunId,
					providerReceiptJson: receipt,
					completedAt: new Date(),
				},
				0,
				["RUNNING"],
			),
		).toMatchObject({
			updated: true,
			run: { status: "SUCCEEDED", resultJson: { status: "failed" } },
		});
		await expect(
			change({ resultJson: report }, 1, ["SUCCEEDED"]),
		).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
		expect(
			await change({ cleanupStatus: "CONFIRMED" }, 1, ["SUCCEEDED"]),
		).toMatchObject({ updated: true });
		await expect(
			change({ cleanupStatus: "BLOCKED" }, 2, ["SUCCEEDED"]),
		).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
	});
	it("honors a cancellation between the initial read and conditional update", async () => {
		await seedRun({ status: "RUNNING", remoteRunId: "56" });
		const original =
			store.client.projectContextQualityRun.updateMany.getMockImplementation()!;
		store.client.projectContextQualityRun.updateMany.mockImplementationOnce(
			async (args) => {
				Object.assign(store.runs[0]!, {
					status: "CANCEL_REQUESTED",
					cancelRequestedAt: new Date(),
					stateVersion: 1,
				});
				return original(args);
			},
		);
		expect(
			await change({ remoteState: "RUNNING" }, 0, ["RUNNING"]),
		).toMatchObject({
			updated: false,
			run: { status: "CANCEL_REQUESTED" },
		});
	});
});

describe("retention and project deletion guards", () => {
	it("purges expired private bytes despite uncertain remote state and retains frozen cleanup evidence", async () => {
		const receipt = {
			version: 1,
			fabricRunId: runScope.runId,
			payloadHash: admission().payloadHash,
			experimentId: "34",
			mlflowRunId: "a".repeat(32),
		};
		await seedRun({
			status: "RECONCILIATION_REQUIRED",
			cleanupStatus: "BLOCKED",
			remoteRunId: "56",
			providerReceiptJson: receipt,
			snapshotExpiresAt: new Date(0),
		});
		expect(await purgeContextQualityRunSnapshot(runScope)).toBe(1);
		expect(await purgeContextQualityRunSnapshot(runScope)).toBe(0);
		expect(store.runs[0]).toMatchObject({
			snapshotPayload: null,
			providerReceiptJson: receipt,
			remoteRunId: "56",
			cleanupStatus: "BLOCKED",
			bindingConfigHash: configHash,
		});
		const recovery = await findContextQualityRunsForRecovery({
			before: new Date(),
		});
		expect(recovery).toHaveLength(1);
		expect(recovery[0]).not.toHaveProperty("snapshotPayload");
	});
	it.each([
		{ status: "RUNNING", cleanupStatus: "CONFIRMED" },
		{ status: "FAILED", cleanupStatus: "BLOCKED" },
		{
			status: "CANCELLED",
			cleanupStatus: "NOT_REQUIRED",
			remoteRunId: "56",
		},
		{
			status: "FAILED",
			cleanupStatus: "NOT_REQUIRED",
			remoteInputPath:
				"/Volumes/example/example/example/example-run.json",
		},
		{
			status: "FAILED",
			cleanupStatus: "NOT_REQUIRED",
			providerReceiptJson: { version: 1 },
		},
	])(
		"does not delete unresolved execution or cleanup evidence: %j",
		async (state) => {
			await seedRun(state);
			expect(
				await deleteSettledContextQualityRunsForProject(scope),
			).toEqual({ deleted: false, pending: 1 });
			expect(store.runs).toHaveLength(1);
			expect(store.bindings).toHaveLength(1);
		},
	);
	it.each(["CONFIRMED", "NOT_REQUIRED"])(
		"allows terminal deletion only after %s cleanup",
		async (cleanupStatus) => {
			await seedRun({
				status: "CANCELLED",
				cleanupStatus,
				...(cleanupStatus === "CONFIRMED" ? { remoteRunId: "56" } : {}),
			});
			expect(
				await deleteSettledContextQualityRunsForProject(scope),
			).toEqual({ deleted: true, pending: 0 });
			expect(store.runs).toHaveLength(0);
			expect(store.bindings).toHaveLength(0);
		},
	);
	it("scrubs private input immediately on settlement without discarding safe reports or cleanup receipts", async () => {
		await seedRun({
			status: "SUCCEEDED",
			cleanupStatus: "BLOCKED",
			resultJson: report,
		});
		expect(await purgeSettledContextQualityRunSnapshot(runScope)).toBe(1);
		expect(store.runs[0]).toMatchObject({
			snapshotPayload: null,
			resultJson: report,
			cleanupStatus: "BLOCKED",
		});
		expect(await purgeSettledContextQualityRunSnapshot(runScope)).toBe(0);
	});
	it("does not prematurely purge an unresolved admission that still needs its immutable input", async () => {
		await seedRun({
			status: "RECONCILIATION_REQUIRED",
			cleanupStatus: "CONFIRMED",
		});
		expect(await purgeSettledContextQualityRunSnapshot(runScope)).toBe(0);
		expect(store.runs[0]?.snapshotPayload).not.toBeNull();
	});
	it("can revoke approval locally after the shared connection is removed", async () => {
		await saveContextQualityBinding(bindingInput);
		store.integrations = [];
		await disableContextQualityBinding({
			...scope,
			actorId: "example-admin",
		});
		expect(store.bindings[0]).toMatchObject({
			isEnabled: false,
			exportApprovedAt: null,
			exportApprovedBy: null,
		});
	});
	it("keeps organization purge from discarding a native receipt labeled as having no cleanup obligation", async () => {
		await seedRun({
			status: "FAILED",
			cleanupStatus: "NOT_REQUIRED",
			remoteRunId: "56",
		});
		await expect(
			deleteSettledContextQualityRunsForOrganizationInTransaction(
				store.client as unknown as Prisma.TransactionClient,
				scope.organizationId,
			),
		).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
		expect(store.runs).toHaveLength(1);
		expect(store.bindings).toHaveLength(1);
		expect(
			store.client.projectContextQualityPrincipal.deleteMany,
		).not.toHaveBeenCalled();
	});
	it("purges confirmed organization receipts and releases only that organization's principal claims", async () => {
		await seedRun({
			status: "SUCCEEDED",
			cleanupStatus: "CONFIRMED",
			remoteRunId: "56",
		});
		store.principals.push(
			{ fingerprint: sha("own"), organizationId: scope.organizationId },
			{ fingerprint: sha("other"), organizationId: "example-other-org" },
		);
		await deleteSettledContextQualityRunsForOrganizationInTransaction(
			store.client as unknown as Prisma.TransactionClient,
			scope.organizationId,
		);
		expect(store.runs).toHaveLength(0);
		expect(store.bindings).toHaveLength(0);
		expect(store.principals).toEqual([
			{ fingerprint: sha("other"), organizationId: "example-other-org" },
		]);
		expect(store.client.$executeRaw).toHaveBeenCalled();
	});
});
