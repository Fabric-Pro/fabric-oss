import { ORPCError } from "@orpc/server";
import { db, getRegisteredAgentById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requireInputOrgPermission,
	resolveOrganizationId,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

function summarize(params: {
	displayName: string;
	conversationCount: number;
	messagesLast7d: number;
	activeDaysLast30d: number;
	lastUsedAt?: string | null;
	status: string;
}) {
	const parts: string[] = [];

	if (params.conversationCount === 0) {
		parts.push(`${params.displayName} has not been used yet.`);
	} else {
		parts.push(
			`${params.displayName} has handled ${params.conversationCount} conversation${params.conversationCount === 1 ? "" : "s"} in this visible context.`,
		);
	}

	if (params.messagesLast7d > 0) {
		parts.push(
			`${params.messagesLast7d} message${params.messagesLast7d === 1 ? "" : "s"} were recorded in the last 7 days.`,
		);
	} else {
		parts.push("No messages were recorded in the last 7 days.");
	}

	if (params.activeDaysLast30d > 0) {
		parts.push(
			`The agent was active on ${params.activeDaysLast30d} distinct day${params.activeDaysLast30d === 1 ? "" : "s"} in the last 30 days.`,
		);
	}

	if (params.status !== "ACTIVE") {
		parts.push(
			`Registry status is currently ${params.status.toLowerCase()}.`,
		);
	}

	if (params.lastUsedAt) {
		parts.push(
			`Last activity was ${new Date(params.lastUsedAt).toLocaleString()}.`,
		);
	}

	return parts.join(" ");
}

async function assertAgentAccess(params: {
	agent: Awaited<ReturnType<typeof getRegisteredAgentById>>;
	userId: string;
	organizationId?: string;
}) {
	const { agent, userId, organizationId } = params;

	if (!agent) {
		throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
	}

	if (agent.scope === "SYSTEM") {
		return;
	}

	if (agent.scope === "USER") {
		if (agent.userId !== userId) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this agent",
			});
		}
		return;
	}

	if (!agent.organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "Invalid organization agent configuration",
		});
	}

	const membership = await verifyOrganizationMembership(
		agent.organizationId,
		userId,
	);
	if (!membership) {
		throw new ORPCError("FORBIDDEN", {
			message: "You do not have access to this agent",
		});
	}

	if (organizationId && organizationId !== agent.organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "Agent does not belong to the specified organization",
		});
	}
}

export const getAgentObservability = protectedProcedure
	.use(requireInputOrgPermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/agents/registry/:id/observability",
		tags: ["Agent Registry"],
		summary: "Get agent observability summary",
		description:
			"Returns lightweight product-facing metrics and a summary for a registered agent.",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			metrics: z.object({
				conversationCount: z.number(),
				messagesLast7d: z.number(),
				activeDaysLast30d: z.number(),
				lastUsedAt: z.string().nullable(),
				status: z.string(),
			}),
			summaryText: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const agent = await getRegisteredAgentById(input.id);
		await assertAgentAccess({
			agent,
			userId: context.user.id,
			organizationId: organizationId ?? undefined,
		});

		const scopeWhere = organizationId
			? { organizationId }
			: { organizationId: null, userId: context.user.id };
		const conversations = await db.agentConversation.findMany({
			where: {
				agentId: agent?.agentId,
				...scopeWhere,
			},
			select: {
				id: true,
				updatedAt: true,
				messages: true,
			},
			orderBy: {
				updatedAt: "desc",
			},
		});

		const now = Date.now();
		const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
		const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
		let messagesLast7d = 0;
		const activeDays = new Set<string>();

		for (const conversation of conversations) {
			const updatedAt = conversation.updatedAt.getTime();
			if (updatedAt >= sevenDaysAgo) {
				const messages = Array.isArray(conversation.messages)
					? (conversation.messages as unknown[])
					: [];
				messagesLast7d += messages.length;
			}
			if (updatedAt >= thirtyDaysAgo) {
				activeDays.add(
					conversation.updatedAt.toISOString().slice(0, 10),
				);
			}
		}

		const lastUsedAt = conversations[0]?.updatedAt?.toISOString() ?? null;
		const metrics = {
			conversationCount: conversations.length,
			messagesLast7d,
			activeDaysLast30d: activeDays.size,
			lastUsedAt,
			// biome-ignore lint/style/noNonNullAssertion: agent is guaranteed non-null — assertAgentAccess throws if null
			status: agent!.status,
		};

		return {
			metrics,
			summaryText: summarize({
				// biome-ignore lint/style/noNonNullAssertion: agent is guaranteed non-null — assertAgentAccess throws if null
				displayName: agent!.displayName,
				...metrics,
			}),
		};
	});
