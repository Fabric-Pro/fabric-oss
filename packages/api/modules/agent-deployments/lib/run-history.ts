import { ORPCError } from "@orpc/server";
import {
	db,
	getAgentTemplateInstanceForRead,
	Prisma,
	readAgentExecutionAdmission,
} from "@repo/database";
import { Permissions } from "@repo/permissions";
import { readNativeExecutionState } from "../../external-api/lib/native-execution-state";
import { canReadAgentExecution } from "../../external-api/procedures/get-execution";
import { authorizeRunCommand, type RunCommandActor } from "./run-commands";
import { agentRunHistorySchema } from "./run-contracts";
import { resolveRunControlInstance } from "./run-control-access";
import {
	decodeRunHistoryCursor,
	encodeRunHistoryCursor,
	runHistoryFilterHash,
} from "./run-history-cursor";

type Row = {
	id: string;
	executionId: string;
	deploymentId: string;
	userId: string;
	organizationId: string;
	workflowId: string | null;
	runId: string | null;
	metadata: Prisma.JsonValue;
	instanceId: string;
	agentStableId: string;
	agentName: string;
	task: string;
	status: string;
	lastRecordedStatus: string;
	queuedAt: Date;
	createdAt: Date;
	completedAt: Date | null;
	duration: number | null;
	triggerType: string;
};
const terminal = (status: string) =>
	["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(status);
const escapeLike = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;
const normalizedStatus = Prisma.sql`CASE WHEN e.status::text='COMPLETED' AND e.output->>'goalAchieved'='false' THEN 'FAILED' ELSE e.status::text END`;

/** A phase-local cache; the emission phase independently rechecks the newest version and ACL. */
function currentAgentReader(actor: RunCommandActor) {
	const cache = new Map<
		string,
		Promise<{ id: string; name: string } | undefined>
	>();
	return (stableId: string) => {
		let current = cache.get(stableId);
		if (!current) {
			current = (async () => {
				// Select the latest version before testing ownership: a transfer must not fall back to an old owned version.
				const instance = await db.agentTemplateInstance.findFirst({
					where: {
						sId: stableId,
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
				if (
					!instance ||
					instance.userId !== actor.userId ||
					instance.organizationId !== actor.organizationId
				) {
					return;
				}
				const scoped = await getAgentTemplateInstanceForRead({
					instanceId: instance.id,
					userId: actor.userId,
					organizationId: actor.organizationId,
				});
				return scoped
					? { id: instance.id, name: instance.name.slice(0, 240) }
					: undefined;
			})();
			cache.set(stableId, current);
		}
		return current;
	};
}

/** The deployment pointer can move on edit; admission is the immutable original instance. */
function historyExecutionReader(actor: RunCommandActor) {
	const originalAccess = new Map<string, Promise<boolean>>();
	return async (row: Row) => {
		if (
			!(await canReadAgentExecution(row.id, {
				...actor,
				scopes: ["agents:read"],
			}))
		) {
			return false;
		}
		const originalId =
			readAgentExecutionAdmission(row)?.dispatch.instanceId;
		if (!originalId) {
			return true; // Legacy rows have no provable original version; their DTO reports null.
		}
		let permitted = originalAccess.get(originalId);
		if (!permitted) {
			permitted = getAgentTemplateInstanceForRead({
				instanceId: originalId,
				...actor,
			}).then((value) => !!value);
			originalAccess.set(originalId, permitted);
		}
		return permitted;
	};
}

/** One bounded metadata page; historical and current-version access are both required. */
export async function searchAgentRunCommand(
	principal: RunCommandActor,
	raw: unknown,
) {
	const actor = {
		userId: principal.userId,
		organizationId: principal.organizationId,
	};
	await authorizeRunCommand(actor, Permissions.AGENT_READ);
	const input = agentRunHistorySchema.parse(raw);
	const instance = input.instanceId
		? await resolveRunControlInstance(input.instanceId, actor)
		: undefined;
	const logicalInstance = instance
		? await db.agentTemplateInstance.findFirst({
				where: { id: instance.id, ...actor },
				select: { sId: true },
			})
		: undefined;
	if (instance && !logicalInstance) {
		throw new ORPCError("NOT_FOUND", {
			message: "Agent not found or access denied",
		});
	}
	const filters = runHistoryFilterHash({
		instanceId: logicalInstance?.sId ?? null,
		status: input.status ?? null,
		triggerType: input.triggerType ?? null,
		from: input.from ?? null,
		to: input.to ?? null,
		query: input.query ?? null,
	});
	const position = decodeRunHistoryCursor(input.cursor, actor, filters);
	const conditions: Prisma.Sql[] = [
		Prisma.sql`e."userId"=${actor.userId} AND e."organizationId"=${actor.organizationId}`,
		Prisma.sql`d."userId"=${actor.userId} AND d."organizationId"=${actor.organizationId}`,
		Prisma.sql`i."userId"=${actor.userId} AND i."organizationId"=${actor.organizationId}`,
		Prisma.sql`current_agent."userId"=${actor.userId} AND current_agent."organizationId"=${actor.organizationId}`,
	];
	if (logicalInstance) {
		conditions.push(Prisma.sql`i."sId"=${logicalInstance.sId}`);
	}
	if (input.status === "ACTIVE") {
		conditions.push(
			Prisma.sql`e.status::text IN ('PENDING','RUNNING','WAITING_INPUT')`,
		);
	} else if (input.status) {
		conditions.push(Prisma.sql`${normalizedStatus}=${input.status}`);
	}
	if (input.triggerType) {
		conditions.push(
			Prisma.sql`upper(e."triggerType")=${input.triggerType}`,
		);
	}
	if (input.from) {
		conditions.push(Prisma.sql`e."queuedAt">=${new Date(input.from)}`);
	}
	if (input.to) {
		conditions.push(Prisma.sql`e."queuedAt"<=${new Date(input.to)}`);
	}
	if (position) {
		conditions.push(
			Prisma.sql`(e."queuedAt",e.id)<(${new Date(position.queuedAt)},${position.id})`,
		);
	}
	if (input.query) {
		const pattern = escapeLike(input.query);
		conditions.push(
			Prisma.sql`(e.id ILIKE ${pattern} OR e."executionId" ILIKE ${pattern} OR current_agent.name ILIKE ${pattern} OR e.input->>'message' ILIKE ${pattern})`,
		);
	}
	const scanLimit = Math.min(input.limit * 4, 200);
	const rows = await db.$queryRaw<Row[]>(Prisma.sql`
  SELECT e.id,e."executionId",e."deploymentId",e."userId",e."organizationId",e."workflowId",e."runId",
  CASE WHEN e.metadata ? 'fabricAdmission' THEN jsonb_build_object('fabricAdmission',e.metadata->'fabricAdmission') ELSE NULL END AS metadata,
  current_agent.id AS "instanceId",i."sId" AS "agentStableId",left(current_agent.name,240) AS "agentName",left(COALESCE(e.input->>'message',''),240) AS task,
  ${normalizedStatus} AS status,e.status::text AS "lastRecordedStatus",e."queuedAt",e."createdAt",e."completedAt",e.duration,upper(left(e."triggerType",64)) AS "triggerType"
  FROM agent_deployment_execution e JOIN agent_deployment d ON d.id=e."deploymentId"
  JOIN agent_template_instance i ON i.id=d."instanceId"
  JOIN LATERAL (SELECT latest.id,latest.name,latest."userId",latest."organizationId" FROM agent_template_instance latest WHERE latest."sId"=i."sId" AND latest."organizationId"=${actor.organizationId} ORDER BY latest.version DESC,latest.id DESC LIMIT 1) current_agent ON TRUE
  WHERE ${Prisma.join(conditions, " AND ")}
  ORDER BY e."queuedAt" DESC,e.id DESC LIMIT ${scanLimit + 1}::integer
 `);
	const beforeExecution = historyExecutionReader(actor);
	const candidates = rows.slice(0, scanLimit);
	type Native = Awaited<ReturnType<typeof readNativeExecutionState>>;
	const chosen: Array<{ row: Row; native: Native | undefined }> = [];
	const beforeCurrent = currentAgentReader(actor);
	let consumed = 0;
	let liveChecks = 0;
	for (
		let start = 0;
		start < candidates.length && chosen.length < input.limit;
		start += 8
	) {
		const batch = candidates.slice(start, start + 8);
		const allowed = await Promise.all(
			batch.map(
				async (row) =>
					(await beforeExecution(row)) &&
					!!(await beforeCurrent(row.agentStableId)),
			),
		);
		const native = await Promise.all(
			batch.map((row, index) =>
				allowed[index] && !terminal(row.status) && liveChecks++ < 5
					? readNativeExecutionState(row, { metadataOnly: true })
					: undefined,
			),
		);
		for (
			let index = 0;
			index < batch.length && chosen.length < input.limit;
			index++
		) {
			consumed = start + index + 1;
			if (!allowed[index]) {
				continue;
			}
			// A completed Temporal wrapper can contain a business failure: metadata-only reads never infer success.
			if (
				input.status === "ACTIVE" &&
				(native[index]?.workflowClosed ||
					terminal(native[index]?.status ?? ""))
			) {
				continue;
			}
			chosen.push({ row: batch[index], native: native[index] });
		}
	}
	await authorizeRunCommand(actor, Permissions.AGENT_READ);
	if (instance) {
		await resolveRunControlInstance(instance.id, actor);
	}
	const afterCurrent = currentAgentReader(actor);
	const afterExecution = historyExecutionReader(actor);
	const checked = await Promise.all(
		chosen.map(async ({ row, native }) => {
			if (!(await afterExecution(row))) {
				return;
			}
			const current = await afterCurrent(row.agentStableId);
			if (!current) {
				return;
			}
			return {
				id: row.id,
				instanceId: current.id,
				executionInstanceId:
					readAgentExecutionAdmission(row)?.dispatch.instanceId ??
					null,
				agentName: current.name,
				task: row.task,
				status:
					native?.status ??
					(terminal(row.status) ? row.status : "UNKNOWN"),
				lastRecordedStatus: row.lastRecordedStatus,
				queuedAt: row.queuedAt,
				createdAt: row.createdAt,
				completedAt: native?.completedAt ?? row.completedAt,
				duration: native?.durationMs ?? row.duration,
				triggerType: row.triggerType,
			};
		}),
	);
	const last = candidates[consumed - 1];
	return {
		executions: checked.filter((row) => row !== undefined),
		nextCursor:
			last && consumed < rows.length
				? encodeRunHistoryCursor(
						{ id: last.id, queuedAt: last.queuedAt.toISOString() },
						actor,
						filters,
					)
				: null,
	};
}
