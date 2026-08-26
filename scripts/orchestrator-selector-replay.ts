import { writeFileSync } from "node:fs";
import { db } from "@repo/database";
import {
	detectUserIntent,
	searchAvailableTools,
	shouldSearchIntegrations,
} from "@repo/temporal/activities";

interface ConversationExecutionRecord {
	id?: string;
	userMessage?: string;
	routingDecision?: {
		primaryAgent?: string;
		matchedMcpTools?: Array<{ toolName?: string }>;
		selectorTelemetry?: Record<string, unknown>;
	};
	stepResults?: Array<{
		toolCalls?: Array<{ name?: string }>;
	}>;
	status?: string;
	startedAt?: string;
	completedAt?: string;
}

interface ReplayRow {
	conversationId: string;
	executionId?: string;
	userId: string;
	organizationId: string | null;
	userMessage: string;
	actualFirstTool?: string;
	historicalPrimaryAgent?: string;
	currentTop1?: string;
	currentTop3: string[];
	top1MatchesActual: boolean;
	top3ContainsActual: boolean;
	searchStrategy?: string;
	integrationSearchTriggered: boolean;
}

function getArg(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	if (index === -1) {
		return undefined;
	}
	return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
	return process.argv.includes(flag);
}

function getActualFirstTool(
	execution: ConversationExecutionRecord,
): string | undefined {
	for (const step of execution.stepResults ?? []) {
		for (const toolCall of step.toolCalls ?? []) {
			if (toolCall.name) {
				return toolCall.name;
			}
		}
	}

	const matchedTool = execution.routingDecision?.matchedMcpTools?.find(
		(tool) => tool.toolName,
	)?.toolName;
	return matchedTool;
}

async function main() {
	const limit = Number.parseInt(getArg("--limit") ?? "100", 10);
	const days = Number.parseInt(getArg("--days") ?? "30", 10);
	const userId = getArg("--user");
	const organizationId = getArg("--org");
	const outputPath = getArg("--output");

	const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

	const conversations = await db.agentConversation.findMany({
		where: {
			// Canonical RegisteredAgent.agentId. Existing rows were
			// renamed from "fabric-ai" → "fabric-workspace-assistant"
			// by the Prisma migration in the round-2 cleanup PR.
			agentId: "fabric-workspace-assistant",
			updatedAt: { gte: since },
			...(userId ? { userId } : {}),
			...(organizationId ? { organizationId } : {}),
		},
		select: {
			id: true,
			userId: true,
			organizationId: true,
			metadata: true,
			updatedAt: true,
		},
		orderBy: { updatedAt: "desc" },
		take: limit * 4,
	});

	const rows: ReplayRow[] = [];

	for (const conversation of conversations) {
		const metadata = (conversation.metadata ?? {}) as {
			mode?: string;
			selectedMcpConfigIds?: string[];
			executions?: ConversationExecutionRecord[];
		};

		if (metadata.mode !== "orchestrator") {
			continue;
		}

		for (const execution of metadata.executions ?? []) {
			if (!execution.userMessage) {
				continue;
			}

			const actualFirstTool = getActualFirstTool(execution);
			if (!actualFirstTool && !hasFlag("--include-without-actual")) {
				continue;
			}

			const toolSearchResult = await searchAvailableTools({
				query: execution.userMessage,
				userId: conversation.userId,
				organizationId: conversation.organizationId ?? undefined,
				enabledMcpConfigIds:
					Array.isArray(metadata.selectedMcpConfigIds) &&
					metadata.selectedMcpConfigIds.length > 0
						? metadata.selectedMcpConfigIds
						: undefined,
			});

			const top3 = toolSearchResult.results
				.slice(0, 3)
				.map((result) => result.toolName);
			const detectedIntent = detectUserIntent(execution.userMessage);
			const integrationSearchTriggered = shouldSearchIntegrations({
				message: execution.userMessage,
				toolResults: toolSearchResult.results.map((result) => ({
					toolName: result.toolName,
					serverName: result.serverName,
					confidence: result.confidence,
				})),
				userIntent: detectedIntent,
			});

			rows.push({
				conversationId: conversation.id,
				executionId: execution.id,
				userId: conversation.userId,
				organizationId: conversation.organizationId,
				userMessage: execution.userMessage,
				actualFirstTool,
				historicalPrimaryAgent: execution.routingDecision?.primaryAgent,
				currentTop1: top3[0],
				currentTop3: top3,
				top1MatchesActual:
					!!actualFirstTool && top3[0] === actualFirstTool,
				top3ContainsActual:
					!!actualFirstTool && top3.includes(actualFirstTool),
				searchStrategy: toolSearchResult.telemetry?.strategy,
				integrationSearchTriggered,
			});

			if (rows.length >= limit) {
				break;
			}
		}

		if (rows.length >= limit) {
			break;
		}
	}

	const labeledRows = rows.filter((row) => row.actualFirstTool);
	const summary = {
		sampledExecutions: rows.length,
		labeledExecutions: labeledRows.length,
		top1Accuracy:
			labeledRows.length > 0
				? labeledRows.filter((row) => row.top1MatchesActual).length /
					labeledRows.length
				: 0,
		top3Recall:
			labeledRows.length > 0
				? labeledRows.filter((row) => row.top3ContainsActual).length /
					labeledRows.length
				: 0,
		strategyBreakdown: Object.entries(
			rows.reduce<Record<string, number>>((acc, row) => {
				const key = row.searchStrategy ?? "unknown";
				acc[key] = (acc[key] ?? 0) + 1;
				return acc;
			}, {}),
		)
			.sort((a, b) => b[1] - a[1])
			.map(([strategy, count]) => ({ strategy, count })),
		integrationSearchRate:
			rows.length > 0
				? rows.filter((row) => row.integrationSearchTriggered).length /
					rows.length
				: 0,
	};

	const report = {
		generatedAt: new Date().toISOString(),
		since,
		summary,
		rows,
	};

	if (outputPath) {
		writeFileSync(
			outputPath,
			`${JSON.stringify(report, null, 2)}\n`,
			"utf8",
		);
		console.log(`Wrote replay report to ${outputPath}`);
	}

	console.log(JSON.stringify(report, null, 2));
}

main()
	.catch((error) => {
		console.error("[selector-replay] failed", error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await db.$disconnect();
	});
