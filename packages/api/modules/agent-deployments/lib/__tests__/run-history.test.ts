import { ORPCError } from "@orpc/server";
import { encryptApiKey } from "@repo/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	stable: vi.fn(),
	member: vi.fn(),
	query: vi.fn(),
	resolve: vi.fn(),
	native: vi.fn(),
	find: vi.fn(),
	scoped: vi.fn(),
	project: vi.fn(),
	deleted: vi.fn(),
}));
// Keep tagged SQL composable and parameterized so the fixture exercises its predicates.
vi.mock("@repo/database", () => {
	type Sql = { text: string; values: unknown[] };
	const sql = (parts: TemplateStringsArray, ...args: unknown[]): Sql => {
		const values: unknown[] = [];
		let text = parts[0];
		args.forEach((value, index) => {
			if (
				value &&
				typeof value === "object" &&
				"text" in value &&
				"values" in value
			) {
				const fragment = value as Sql;
				text += fragment.text.replace(
					/\$(\d+)/g,
					(_, number) => `$${Number(number) + values.length}`,
				);
				values.push(...fragment.values);
			} else {
				values.push(value);
				text += `$${values.length}`;
			}
			text += parts[index + 1];
		});
		return { text, values };
	};
	return {
		db: {
			agentTemplateInstance: { findFirst: m.stable },
			member: { findFirst: m.member },
			$queryRaw: m.query,
			agentDeploymentExecution: { findFirst: m.find },
		},
		Prisma: {
			sql,
			join: (parts: Sql[], separator: string) =>
				parts.reduce((a, b, index) =>
					index
						? sql`${a}${sql([separator] as unknown as TemplateStringsArray)}${b}`
						: b,
				),
		},
		getAgentTemplateInstanceForExecution: vi.fn(),
		getAgentTemplateInstanceForRead: m.scoped,
		getProjectAccessContext: m.project,
		isProjectSoftDeleted: m.deleted,
		readAgentExecutionAdmission: (row: { metadata?: unknown }) =>
			(row.metadata as { fabricAdmission?: unknown } | undefined)
				?.fabricAdmission,
	};
});
vi.mock("@repo/temporal", () => ({ getTemporalClient: vi.fn() }));
vi.mock("@repo/storage", () => ({ getSignedUrl: vi.fn() }));
vi.mock("../run-control-access", () => ({
	resolveRunControlInstance: m.resolve,
	getOwnedRunDeployment: vi.fn(),
}));
vi.mock("../managed-run-schedule", () => ({
	buildManagedRunCalendar: vi.fn(),
	readManagedRunSchedule: vi.fn(),
	saveManagedRunSchedule: vi.fn(),
}));
vi.mock("../../../external-api/procedures/execute-agent", () => ({
	getOrCreateDeployment: vi.fn(),
}));
vi.mock("../../../external-api/lib/native-execution-state", () => ({
	readNativeExecutionState: m.native,
}));

import { searchAgentRunCommand } from "../run-history";
import {
	decodeRunHistoryCursor,
	encodeRunHistoryCursor,
	runHistoryFilterHash,
} from "../run-history-cursor";

const actor = { userId: "example-user", organizationId: "example-org" };
const row = (number: number) => ({
	id: `example-run-${String(number).padStart(5, "0")}`,
	executionId: `example-business-${number}`,
	deploymentId: "example-deployment",
	...actor,
	workflowId: "example-workflow",
	runId: "example-native-run",
	metadata: {
		fabricAdmission: {
			version: 1,
			requestHash: "a".repeat(64),
			imageRefs: [],
			dispatch: {
				projectId: "example-project",
				instanceId: "example-instance",
				workflowType: "nativeDeploymentExecutionWorkflow",
			},
		},
	},
	instanceId: "example-current-agent",
	deploymentInstanceId: "example-instance",
	agentStableId: "example-stable-agent",
	agentName: "Delivery reporter",
	task: "Report progress",
	status: "COMPLETED",
	lastRecordedStatus: "COMPLETED",
	queuedAt: new Date("2026-01-01T00:00:00.000Z"),
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	completedAt: new Date("2026-01-01T00:01:00.000Z"),
	duration: 60000,
	triggerType: "MANUAL",
});
type Row = Omit<ReturnType<typeof row>, "metadata"> & { metadata: unknown };
let data: Row[];
function installFixture() {
	m.find.mockImplementation(
		async ({
			where,
		}: {
			where: { id: string; userId: string; organizationId: string };
		}) => {
			const found = data.find(
				(r) =>
					r.id === where.id &&
					r.userId === where.userId &&
					r.organizationId === where.organizationId,
			);
			return found
				? {
						metadata: found.metadata,
						deployment: {
							instanceId: found.deploymentInstanceId,
							userId: found.userId,
							organizationId: found.organizationId,
						},
					}
				: null;
		},
	);
	m.query.mockImplementation(
		async ({ text, values }: { text: string; values: unknown[] }) => {
			const param = (pattern: RegExp) => {
				const match = text.match(pattern);
				return match ? values[Number(match[1]) - 1] : undefined;
			};
			const owner = param(/e\."userId"=\$(\d+)/);
			const org = param(/e\."organizationId"=\$(\d+)/);
			const instance = param(/i\."sId"=\$(\d+)/);
			const status = param(/END=\$(\d+)/);
			const trigger = param(/upper\(e\."triggerType"\)=\$(\d+)/);
			const from = param(/e\."queuedAt">=\$(\d+)/) as Date | undefined;
			const to = param(/e\."queuedAt"<=\$(\d+)/) as Date | undefined;
			const pattern = param(/e\.id ILIKE \$(\d+)/) as string | undefined;
			const query = pattern
				?.slice(1, -1)
				.replace(/\\([\\%_])/g, "$1")
				.toLowerCase();
			const active = text.includes(
				"e.status::text IN ('PENDING','RUNNING','WAITING_INPUT')",
			);
			const position = text.match(
				/\(e\."queuedAt",e\.id\)<\(\$(\d+),\$(\d+)\)/,
			);
			return data
				.filter(
					(r) =>
						r.userId === owner &&
						r.organizationId === org &&
						(!instance || r.agentStableId === instance),
				)
				.filter(
					(r) =>
						!position ||
						r.queuedAt <
							(values[Number(position[1]) - 1] as Date) ||
						(r.queuedAt.getTime() ===
							(
								values[Number(position[1]) - 1] as Date
							).getTime() &&
							r.id < (values[Number(position[2]) - 1] as string)),
				)
				.filter(
					(r) =>
						(!status || r.status === status) &&
						(!trigger || r.triggerType === trigger) &&
						(!from || r.queuedAt >= from) &&
						(!to || r.queuedAt <= to) &&
						(!active ||
							["PENDING", "RUNNING", "WAITING_INPUT"].includes(
								r.status,
							)) &&
						(!query ||
							[r.id, r.executionId, r.agentName, r.task].some(
								(value) => value.toLowerCase().includes(query),
							)),
				)
				.sort(
					(a, b) =>
						b.queuedAt.getTime() - a.queuedAt.getTime() ||
						b.id.localeCompare(a.id),
				)
				.slice(0, values.at(-1) as number);
		},
	);
}
beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv(
		"BETTER_AUTH_SECRET",
		"example-run-history-encryption-secret-for-tests",
	);
	vi.stubEnv("ENCRYPTION_KEYS", "");
	vi.stubEnv("ENCRYPTION_ACTIVE_KEY_VERSION", "");
	data = [row(1)];
	m.stable.mockImplementation(async ({ select }) =>
		select.sId
			? { sId: "example-stable-agent" }
			: {
					id: "example-current-agent",
					name: "Delivery reporter",
					...actor,
				},
	);
	m.member.mockResolvedValue({ role: "owner" });
	m.resolve.mockResolvedValue({ id: "example-instance" });
	m.scoped.mockResolvedValue({ projectId: "example-project" });
	m.project.mockResolvedValue({ organizationId: "example-org" });
	m.deleted.mockResolvedValue(false);
	m.native.mockResolvedValue({
		nativeReadStatus: "AVAILABLE",
		status: "RUNNING",
	});
	installFixture();
});
describe("bounded authorized saved-agent run history", () => {
	it.each([null, { role: "unknown" }])(
		"checks live membership before any run I/O",
		async (member) => {
			m.member.mockResolvedValue(member);
			await expect(
				searchAgentRunCommand(actor, {}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(m.query).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ limit: 51 },
		{ limit: 0 },
		{ limit: 1.5 },
		{ userId: "other-user" },
		{ organizationId: "other-org" },
		{ scopes: ["*"] },
		{ from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z" },
		{ cursor: "x".repeat(4097) },
		{ query: "x\nsecret" },
	])(
		"rejects malformed or injected fields before querying: %j",
		async (input) => {
			await expect(searchAgentRunCommand(actor, input)).rejects.toThrow();
			expect(m.query).not.toHaveBeenCalled();
		},
	);
	it("returns only bounded preview metadata and checks all three owner/tenant joins", async () => {
		data.push(
			{ ...row(2), organizationId: "other-org" },
			{ ...row(3), userId: "another-user" },
		);
		const result = await searchAgentRunCommand(actor, {});
		expect(result.executions.map((r) => r.id)).toEqual([row(1).id]);
		expect(Object.keys(result.executions[0]).sort()).toEqual(
			[
				"id",
				"instanceId",
				"executionInstanceId",
				"agentName",
				"task",
				"status",
				"lastRecordedStatus",
				"queuedAt",
				"createdAt",
				"completedAt",
				"duration",
				"triggerType",
			].sort(),
		);
		const sql = m.query.mock.calls[0][0];
		for (const alias of ["e", "d", "i", "current_agent"]) {
			expect(sql.text).toContain(`${alias}."userId"=`);
			expect(sql.text).toContain(`${alias}."organizationId"=`);
		}
		expect(sql.text).not.toContain("SELECT *");
		expect(sql.text).toContain('ORDER BY e."queuedAt" DESC,e.id DESC');
		expect(sql.text).not.toContain('ORDER BY e."createdAt"');
		expect(sql.text).toContain(
			"left(COALESCE(e.input->>'message',''),240)",
		);
		expect(sql.text).toContain("e.output->>'goalAchieved'='false'");
		expect(sql.values.at(-1)).toBe(101);
		expect(result.nextCursor).toBeNull();
		expect(m.native).not.toHaveBeenCalled();
	});
	it("keeps filters parameterized including literal wildcard task/name queries", async () => {
		await searchAgentRunCommand(actor, {
			instanceId: "example-instance",
			status: "FAILED",
			triggerType: "SCHEDULE",
			from: "2026-01-01T00:00:00Z",
			to: "2026-01-02T00:00:00Z",
			query: "agent%_\\name",
			limit: 50,
		});
		const sql = m.query.mock.calls[0][0];
		expect(sql.values).toContain("%agent\\%\\_\\\\name%");
		expect(sql.text).not.toContain("agent%_");
		expect(sql.values).toContain("FAILED");
		expect(sql.values).toContain("SCHEDULE");
		expect(sql.text).toContain("current_agent.name ILIKE");
		expect(sql.text).toContain('upper(e."triggerType")=');
		expect(sql.values.at(-1)).toBe(201);
		expect(m.resolve).toHaveBeenCalledTimes(2);
	});
	it("combines inclusive time, outcome, trigger and task filters across dates", async () => {
		data = [
			{
				...row(1),
				status: "FAILED",
				triggerType: "SCHEDULE",
				queuedAt: new Date("2026-01-02T00:00:00Z"),
			},
			{
				...row(2),
				status: "FAILED",
				triggerType: "SCHEDULE",
				queuedAt: new Date("2026-01-03T00:00:00Z"),
			},
			{
				...row(3),
				status: "COMPLETED",
				triggerType: "SCHEDULE",
				queuedAt: new Date("2026-01-02T00:00:00Z"),
			},
			{
				...row(4),
				status: "FAILED",
				triggerType: "API",
				queuedAt: new Date("2026-01-02T00:00:00Z"),
			},
		];
		const result = await searchAgentRunCommand(actor, {
			status: "FAILED",
			triggerType: "SCHEDULE",
			from: "2026-01-02T00:00:00Z",
			to: "2026-01-02T00:00:00Z",
			query: "reporter",
		});
		expect(result.executions.map((r) => r.id)).toEqual([row(1).id]);
	});
	it("paginates indexed queued times independently of creation times", async () => {
		data = Array.from({ length: 8 }, (_, i) => ({
			...row(i),
			queuedAt: new Date(`2026-01-0${1 + (i % 4)}T00:00:00Z`),
			createdAt: new Date(`2026-01-0${4 - (i % 4)}T00:00:00Z`),
		}));
		let cursor: string | undefined;
		const ids: string[] = [];
		do {
			const result = await searchAgentRunCommand(actor, {
				limit: 3,
				cursor,
			});
			ids.push(...result.executions.map((r) => r.id));
			cursor = result.nextCursor ?? undefined;
		} while (cursor);
		expect(ids).toEqual([7, 3, 6, 2, 5, 1, 4, 0].map((i) => row(i).id));
	});
	it("pages 1000 same-timestamp runs stably without duplicates or gaps", async () => {
		data = Array.from({ length: 1000 }, (_, i) => row(i));
		const ids: string[] = [];
		let cursor: string | undefined;
		do {
			const result = await searchAgentRunCommand(actor, {
				limit: 25,
				cursor,
			});
			expect(result.executions).toHaveLength(25);
			ids.push(...result.executions.map((r) => r.id));
			cursor = result.nextCursor ?? undefined;
		} while (cursor);
		expect(ids).toHaveLength(1000);
		expect(new Set(ids).size).toBe(1000);
		expect(ids).toEqual([...data].reverse().map((r) => r.id));
		expect(m.query).toHaveBeenCalledTimes(40);
		expect(m.native).not.toHaveBeenCalled();
	}, 20000);
	it("advances opaque cursors through denied windows without exposing denied names/IDs or skipping later allowed rows", async () => {
		data = Array.from({ length: 110 }, (_, i) => row(i));
		m.scoped.mockImplementation(async ({ instanceId }) => ({
			projectId: instanceId,
		}));
		const realFind = m.find.getMockImplementation();
		m.find.mockImplementation(async (args) => {
			const value = await realFind?.(args);
			return Number(args.where.id.split("-").at(-1)) >= 10 ? null : value;
		});
		const first = await searchAgentRunCommand(actor, {});
		expect(first.executions).toEqual([]);
		expect(first.nextCursor).toBeTypeOf("string");
		expect(JSON.stringify(first)).not.toContain("example-run");
		const next = await searchAgentRunCommand(actor, {
			cursor: first.nextCursor,
		});
		expect(next.executions).toHaveLength(10);
		expect(next.nextCursor).toBeNull();
	});
	it("binds continuation to actor, organization and filters, detects tampering, and allows a different page size", async () => {
		data = Array.from({ length: 30 }, (_, i) => row(i));
		const first = await searchAgentRunCommand(actor, { limit: 1 });
		for (const [who, input] of [
			[
				{ ...actor, userId: "another-user" },
				{ cursor: first.nextCursor },
			],
			[
				{ ...actor, organizationId: "another-org" },
				{ cursor: first.nextCursor },
			],
			[actor, { cursor: first.nextCursor, status: "FAILED" }],
			[actor, { cursor: `${first.nextCursor?.slice(0, -8)}aaaaaaaa` }],
		] as const) {
			await expect(
				searchAgentRunCommand(who, input),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		const next = await searchAgentRunCommand(actor, {
			cursor: first.nextCursor,
			limit: 2,
		});
		expect(next.executions).toHaveLength(2);
		expect(next.executions[0].id).not.toBe(first.executions[0].id);
	});
	it("rechecks the original admitted project, current instance access, soft deletion and late revocation", async () => {
		for (const condition of [
			() => m.project.mockResolvedValue({ organizationId: "other-org" }),
			() => m.deleted.mockResolvedValue(true),
			() => m.scoped.mockResolvedValue(null),
		]) {
			m.project.mockResolvedValue({ organizationId: "example-org" });
			m.deleted.mockResolvedValue(false);
			m.scoped.mockResolvedValue({ projectId: "example-project" });
			condition();
			expect((await searchAgentRunCommand(actor, {})).executions).toEqual(
				[],
			);
		}
		m.scoped
			.mockResolvedValueOnce({ projectId: "example-project" })
			.mockResolvedValue(null);
		m.deleted.mockResolvedValue(false);
		expect((await searchAgentRunCommand(actor, {})).executions).toEqual([]);
		m.scoped.mockResolvedValue({ projectId: "example-project" });
		m.member
			.mockResolvedValueOnce({ role: "owner" })
			.mockResolvedValue(null);
		await expect(searchAgentRunCommand(actor, {})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("never polls historical executions and caps active native lookups at five", async () => {
		data = Array.from({ length: 50 }, (_, i) => ({
			...row(i),
			status: i < 10 ? "COMPLETED" : "RUNNING",
		}));
		const result = await searchAgentRunCommand(actor, {
			limit: 50,
			status: "ACTIVE",
		});
		expect(m.native).toHaveBeenCalledTimes(5);
		expect(
			result.executions.filter((r) => r.status === "UNKNOWN"),
		).toHaveLength(35);
	});
	it("includes older owned versions while retaining each run's original admitted project rights", async () => {
		data = [
			{
				...row(1),
				deploymentInstanceId: "example-v1",
				metadata: {
					fabricAdmission: {
						dispatch: {
							projectId: "old-readable-project",
							instanceId: "example-v1",
						},
					},
				},
			},
			{
				...row(2),
				deploymentInstanceId: "example-v1",
				metadata: {
					fabricAdmission: {
						dispatch: {
							projectId: "revoked-project",
							instanceId: "example-v1",
						},
					},
				},
			},
			{
				...row(3),
				deploymentInstanceId: "example-v2",
				metadata: {
					fabricAdmission: {
						dispatch: {
							projectId: "example-project",
							instanceId: "example-v2",
						},
					},
				},
			},
			{
				...row(4),
				deploymentInstanceId: "different-agent",
				agentStableId: "different-stable-agent",
			},
		];
		m.resolve.mockResolvedValue({ id: "example-v2" });
		m.stable.mockImplementation(async ({ select }) =>
			select.sId
				? { sId: "example-stable-agent" }
				: {
						id: "example-v2",
						name: "Renamed delivery reporter",
						...actor,
					},
		);
		m.project.mockImplementation(async (projectId) =>
			projectId === "revoked-project"
				? null
				: { organizationId: actor.organizationId },
		);
		const result = await searchAgentRunCommand(actor, {
			instanceId: "example-v2",
		});
		expect(result.executions.map((r) => r.id)).toEqual([
			row(3).id,
			row(1).id,
		]);
		expect(result.executions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: row(1).id,
					instanceId: "example-v2",
					executionInstanceId: "example-v1",
					agentName: "Renamed delivery reporter",
				}),
				expect.objectContaining({
					id: row(3).id,
					instanceId: "example-v2",
					executionInstanceId: "example-v2",
					agentName: "Renamed delivery reporter",
				}),
			]),
		);
		expect(m.stable).toHaveBeenCalledWith({
			where: { id: "example-v2", ...actor },
			select: { sId: true },
		});
		expect(m.project).toHaveBeenCalledWith(
			"old-readable-project",
			actor.userId,
		);
		expect(m.project).toHaveBeenCalledWith("revoked-project", actor.userId);
	});

	it("preserves immutable admitted provenance after saving edits moves the deployment pointer", async () => {
		data = [
			{
				...row(1),
				deploymentInstanceId: "example-v2",
				metadata: {
					fabricAdmission: {
						version: 1,
						requestHash: "a".repeat(64),
						imageRefs: [],
						dispatch: {
							workflowType: "nativeDeploymentExecutionWorkflow",
							projectId: "example-project",
							instanceId: "example-v1",
						},
					},
				},
			},
		];
		m.stable.mockResolvedValue({
			id: "example-v2",
			name: "Current delivery reporter",
			...actor,
		});
		const result = await searchAgentRunCommand(actor, {});
		expect(result.executions[0]).toEqual(
			expect.objectContaining({
				instanceId: "example-v2",
				executionInstanceId: "example-v1",
				agentName: "Current delivery reporter",
			}),
		);
		expect(m.scoped).toHaveBeenCalledWith({
			instanceId: "example-v1",
			...actor,
		});
		expect(m.scoped).toHaveBeenCalledWith({
			instanceId: "example-v2",
			...actor,
		});
	});
	it("hides an execution if original admitted version access is revoked after deployment moves", async () => {
		data = [
			{
				...row(1),
				deploymentInstanceId: "example-v2",
				metadata: {
					fabricAdmission: {
						dispatch: {
							instanceId: "example-v1",
							projectId: "example-project",
						},
					},
				},
			},
		];
		m.scoped.mockImplementation(async ({ instanceId }) =>
			instanceId === "example-v1"
				? null
				: { projectId: "example-project" },
		);
		expect((await searchAgentRunCommand(actor, {})).executions).toEqual([]);
	});
	it("rechecks original admitted version access before emission", async () => {
		data = [
			{
				...row(1),
				deploymentInstanceId: "example-v2",
				metadata: {
					fabricAdmission: {
						dispatch: {
							instanceId: "example-v1",
							projectId: "example-project",
						},
					},
				},
			},
		];
		let originalReads = 0;
		m.scoped.mockImplementation(async ({ instanceId }) =>
			instanceId !== "example-v1" || ++originalReads === 1
				? { projectId: "example-project" }
				: null,
		);
		expect((await searchAgentRunCommand(actor, {})).executions).toEqual([]);
		expect(originalReads).toBe(2);
	});
	it("reports null original provenance for legacy rows rather than claiming a mutable deployment pointer", async () => {
		data = [
			{ ...row(1), deploymentInstanceId: "example-v2", metadata: {} },
		];
		const result = await searchAgentRunCommand(actor, {});
		expect(result.executions[0].executionInstanceId).toBeNull();
	});
	it("requires current logical-agent access as well as original execution access", async () => {
		m.scoped.mockImplementation(async ({ instanceId }) =>
			instanceId === "example-current-agent"
				? null
				: { projectId: "example-project" },
		);
		const result = await searchAgentRunCommand(actor, {});
		expect(result.executions).toEqual([]);
		expect(m.project).toHaveBeenCalled();
	});
	it("rechecks the current agent after native reads and hides newly revoked metadata", async () => {
		let currentReads = 0;
		m.scoped.mockImplementation(async ({ instanceId }) =>
			instanceId !== "example-current-agent" || ++currentReads === 1
				? { projectId: "example-project" }
				: null,
		);
		expect((await searchAgentRunCommand(actor, {})).executions).toEqual([]);
		expect(currentReads).toBe(2);
	});
	it("does not fall back to an old owned version when the newest version has another owner", async () => {
		m.stable.mockResolvedValue({
			id: "example-transferred-agent",
			name: "Must not be exposed",
			userId: "other-user",
			organizationId: actor.organizationId,
		});
		const result = await searchAgentRunCommand(actor, {});
		expect(result.executions).toEqual([]);
		expect(JSON.stringify(result)).not.toContain("Must not be exposed");
		expect(m.stable).toHaveBeenCalledWith({
			where: {
				sId: "example-stable-agent",
				organizationId: actor.organizationId,
			},
			orderBy: [{ version: "desc" }, { id: "desc" }],
			select: {
				id: true,
				name: true,
				userId: true,
				organizationId: true,
			},
		});
	});
	it("includes WAITING_INPUT in active work and uses metadata-only native checks", async () => {
		data = [
			{
				...row(1),
				status: "WAITING_INPUT",
				lastRecordedStatus: "WAITING_INPUT",
			},
		];
		m.native.mockResolvedValue({
			status: "RUNNING",
			workflowClosed: false,
			nativeReadStatus: "AVAILABLE",
		});
		const result = await searchAgentRunCommand(actor, { status: "ACTIVE" });
		expect(result.executions).toHaveLength(1);
		expect(result.executions[0].lastRecordedStatus).toBe("WAITING_INPUT");
		expect(m.native).toHaveBeenCalledWith(
			expect.objectContaining({ id: row(1).id }),
			{ metadataOnly: true },
		);
	});
	it("omits verified closed native wrappers from ACTIVE and fills from later bounded candidates", async () => {
		data = Array.from({ length: 4 }, (_, i) => ({
			...row(i),
			status: "PENDING",
		}));
		m.native.mockImplementation(async ({ id }) => ({
			status: id === row(3).id ? "UNKNOWN" : "RUNNING",
			workflowClosed: id === row(3).id,
			nativeReadStatus: "AVAILABLE",
		}));
		const result = await searchAgentRunCommand(actor, {
			status: "ACTIVE",
			limit: 1,
		});
		expect(result.executions.map((r) => r.id)).toEqual([row(2).id]);
		expect(result.nextCursor).toBeTypeOf("string");
		expect(m.native).toHaveBeenCalledTimes(4);
		const next = await searchAgentRunCommand(actor, {
			status: "ACTIVE",
			limit: 1,
			cursor: result.nextCursor,
		});
		expect(next.executions.map((r) => r.id)).toEqual([row(1).id]);
	});
	it("does not equate a completed Temporal wrapper with a successful business result", async () => {
		data = [{ ...row(1), status: "PENDING" }];
		m.native.mockResolvedValue({
			status: "UNKNOWN",
			workflowClosed: true,
			nativeReadStatus: "AVAILABLE",
		});
		expect(
			(await searchAgentRunCommand(actor, {})).executions[0].status,
		).toBe("UNKNOWN");
		expect(
			(await searchAgentRunCommand(actor, { status: "ACTIVE" }))
				.executions,
		).toEqual([]);
	});
	it("does not hide a scoped instance refusal", async () => {
		m.resolve.mockRejectedValue(new ORPCError("NOT_FOUND"));
		await expect(
			searchAgentRunCommand(actor, { instanceId: "other-instance" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.query).not.toHaveBeenCalled();
	});
});
describe("opaque run cursor", () => {
	it("rejects prior creation-time cursor purpose and shape", () => {
		const filters = runHistoryFilterHash({});
		const cursor = Buffer.from(
			encryptApiKey(
				JSON.stringify({
					purpose: "fabric-agent-run-history-v1",
					...actor,
					filters,
					createdAt: "2026-01-01T00:00:00.000Z",
					id: "example-run",
				}),
			),
		).toString("base64url");
		expect(() => decodeRunHistoryCursor(cursor, actor, filters)).toThrow(
			/Invalid run history cursor/,
		);
	});

	it("requires encryption configuration instead of emitting plaintext IDs", () => {
		vi.stubEnv("BETTER_AUTH_SECRET", "");
		expect(() =>
			encodeRunHistoryCursor(
				{
					id: "example-denied-id",
					queuedAt: new Date().toISOString(),
				},
				actor,
				runHistoryFilterHash({}),
			),
		).toThrow(/temporarily unavailable/);
	});
	it("round trips only well-formed positions under the matching purpose and filter context", () => {
		const filters = runHistoryFilterHash({ status: "FAILED" });
		const position = {
			id: "example-run",
			queuedAt: "2026-01-01T00:00:00.000Z",
		};
		const cursor = encodeRunHistoryCursor(position, actor, filters);
		expect(Buffer.from(cursor, "base64url").toString()).not.toContain(
			"example-run",
		);
		expect(decodeRunHistoryCursor(cursor, actor, filters)).toEqual(
			position,
		);
		expect(() =>
			decodeRunHistoryCursor(cursor, actor, runHistoryFilterHash({})),
		).toThrow(/Invalid run history cursor/);
	});
});
