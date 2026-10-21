import { ownMcpConfigIds, projectPlacementRefusal } from "@repo/database";
import {
	type AdoStoryReviewConfig,
	adoStoryReviewConfigSchema,
} from "@repo/temporal/ado-story-review-config";
import { agentTaskCapabilityProblem } from "@repo/temporal/agent-task-capabilities";
import {
	type AgentTaskNodeConfig,
	AgentTaskNodeConfigSchema,
	MIN_SCHEDULE_INTERVAL_MINUTES,
	type PublishFrameNodeConfig,
	PublishFrameNodeConfigSchema,
	TRIGGER_NODE_TYPE,
} from "@repo/temporal/agentic-workflow-preset";
import { workflowNativePlatformReadProblems } from "@repo/temporal/native-platform-read-config";
import {
	findScheduleCron,
	findScheduleTimezone,
	isValidScheduleTimeZone,
} from "@repo/temporal/workflow-builder-schedule";
import {
	ADO_STORY_REVIEW_NODE_TYPE,
	AGENT_TASK_NODE_TYPE,
	NATIVE_PLATFORM_READ_NODE_TYPE,
	PUBLISH_FRAME_NODE_TYPE,
} from "@repo/temporal/workflow-node-types";
import { workflowWorkspaceDataProblems } from "@repo/temporal/workspace-data-config";
import { workflowScriptProblems } from "@repo/temporal/workspace-script-config";
import { adoStoryReviewPublishProblems } from "./ado-story-review-publish-validation";
import { minimumCronIntervalMinutes } from "./cron-interval";

interface GraphNode {
	id?: unknown;
	type?: unknown;
	data?: { label?: unknown; config?: unknown };
}

interface ParsedNode<Config> {
	node: GraphNode;
	config: Config;
}

function nodeName(node: GraphNode): string {
	if (typeof node.data?.label === "string" && node.data.label.trim()) {
		return node.data.label;
	}
	return typeof node.id === "string" ? node.id : "node";
}

function describeInterval(minutes: number): string {
	return minutes === 1 ? "every minute" : `every ${minutes} minutes`;
}

function parseConfig<Config>(
	node: GraphNode,
	schema: {
		safeParse(value: unknown):
			| { success: true; data: Config }
			| {
					success: false;
					error: {
						issues: ReadonlyArray<{
							path: PropertyKey[];
							message: string;
						}>;
					};
			  };
	},
	problems: string[],
): ParsedNode<Config> | null {
	const parsed = schema.safeParse(node.data?.config ?? {});
	if (parsed.success) {
		return { node, config: parsed.data };
	}
	for (const issue of parsed.error.issues) {
		const field = issue.path.map(String).join(".") || "config";
		problems.push(`${nodeName(node)}: ${field} — ${issue.message}`);
	}
	return null;
}

function hasText(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * A Schedule trigger without a cron saves and publishes as a manual workflow,
 * so a misnamed field (`cron` for `scheduleCron`) would drop the schedule
 * without a word.
 */
function scheduleTriggerProblems(nodes: unknown[]): string[] {
	const problems: string[] = [];
	for (const node of nodes as GraphNode[]) {
		const config = node?.data?.config;
		if (node?.type !== TRIGGER_NODE_TYPE || !isRecord(config)) {
			continue;
		}
		if (
			String(config.triggerType ?? "").toLowerCase() === "schedule" &&
			!hasText(config.scheduleCron) &&
			!hasText(config.scheduleExpression)
		) {
			problems.push(
				`${nodeName(node)}: a schedule trigger keeps its cron in \`scheduleCron\` and its time zone in \`scheduleTimezone\`. This one has no \`scheduleCron\`, so it would never run on a schedule.`,
			);
		}
	}
	return problems;
}

function scheduleTimezoneProblems(nodes: unknown[]): string[] {
	const timezone = findScheduleTimezone(nodes);
	if (timezone && !isValidScheduleTimeZone(timezone)) {
		return [
			`Schedule: "${timezone}" is not a time zone name. Use an IANA name such as Europe/Berlin, or UTC.`,
		];
	}
	return [];
}

function scheduleIntervalProblems(nodes: unknown[]): string[] {
	const cron = findScheduleCron(nodes);
	if (!cron) {
		return [];
	}
	const interval = minimumCronIntervalMinutes(cron);
	if (interval === null) {
		return [
			`Schedule: "${cron}" is not a schedule whose interval can be checked. An AI review or agent task needs one that runs at most ${describeInterval(MIN_SCHEDULE_INTERVAL_MINUTES)}.`,
		];
	}
	if (interval < MIN_SCHEDULE_INTERVAL_MINUTES) {
		return [
			`Schedule: "${cron}" runs ${describeInterval(interval)}. An AI review or agent task may run at most ${describeInterval(MIN_SCHEDULE_INTERVAL_MINUTES)}.`,
		];
	}
	return [];
}

function builtInCapabilityProblems(
	agents: ParsedNode<AgentTaskNodeConfig>[],
): string[] {
	return agents.flatMap(({ node, config }) =>
		config.builtInToolNames.flatMap((name) => {
			const problem = agentTaskCapabilityProblem(name);
			return problem ? [`${nodeName(node)}: ${problem}`] : [];
		}),
	);
}

/** An MCP connection an agent task names, as the draft shows it. */
interface ResolvedMcpServer {
	configId: string;
	name: string;
}

/**
 * Every MCP server an agent task names must be one of the workflow owner's own,
 * in this organization, and enabled: the agent runs as the owner, so a
 * configuration anyone else holds must never be reachable through it. Fails
 * closed: a server that cannot be looked up is a problem, not a pass. Returns
 * the servers it found, so the draft shows them without a second lookup.
 */
async function mcpServerChecks(
	agents: ParsedNode<AgentTaskNodeConfig>[],
	actor: { userId: string; organizationId: string },
): Promise<{ problems: string[]; servers: ResolvedMcpServer[] }> {
	const ids = [
		...new Set(agents.flatMap(({ config }) => config.mcpConfigIds)),
	];
	if (ids.length === 0) {
		return { problems: [], servers: [] };
	}
	let owned: Awaited<ReturnType<typeof ownMcpConfigIds>>;
	try {
		owned = await ownMcpConfigIds(ids, actor);
	} catch {
		return {
			problems: agents
				.filter(({ config }) => config.mcpConfigIds.length > 0)
				.map(
					({ node }) =>
						`${nodeName(node)}: its MCP servers could not be verified. Try again.`,
				),
			servers: [],
		};
	}
	const byId = new Map(owned.map((config) => [config.id, config]));
	const problems: string[] = [];
	for (const { node, config } of agents) {
		for (const id of new Set(config.mcpConfigIds)) {
			const found = byId.get(id);
			if (!found) {
				problems.push(
					`${nodeName(node)}: MCP server ${id} is not one of your servers in this organization.`,
				);
			} else if (!found.enabled) {
				problems.push(
					`${nodeName(node)}: MCP server "${found.displayName ?? id}" is disabled.`,
				);
			}
		}
	}
	return {
		problems,
		servers: ids.flatMap((configId) => {
			const found = byId.get(configId);
			return found
				? [
						{
							configId,
							name:
								found.displayName ??
								found.mcpServer?.name ??
								configId,
						},
					]
				: [];
		}),
	};
}

/**
 * Where a frame is published has to be a project the owner may add to. An
 * artifact needs one: `projectId` on the input is the workflow's own, and a
 * project named on the node wins over it. The step checks again when it runs.
 */
async function frameProjectProblems(
	publishers: ParsedNode<PublishFrameNodeConfig>[],
	input: {
		userId: string;
		organizationId: string | null;
		projectId: string | null;
	},
): Promise<string[]> {
	const problems: string[] = [];
	const verdicts = new Map<string, string | null>();

	const refusalFor = async (projectId: string): Promise<string | null> => {
		const cached = verdicts.get(projectId);
		if (cached !== undefined) {
			return cached;
		}
		let refusal: string | null;
		try {
			const placement = input.organizationId
				? await projectPlacementRefusal({
						userId: input.userId,
						organizationId: input.organizationId,
						projectId,
					})
				: "not_found";
			refusal =
				placement === "not_found"
					? "the project does not exist or you have no access to it."
					: placement === "not_editable"
						? "you may not add frames to that project."
						: null;
		} catch {
			refusal = "the project could not be verified. Try again.";
		}
		verdicts.set(projectId, refusal);
		return refusal;
	};

	for (const { node, config } of publishers) {
		const projectId = config.projectId ?? input.projectId;
		if (!projectId) {
			if (config.surface === "artifact") {
				problems.push(
					`${nodeName(node)}: an artifact needs a project. Choose one on this step or link the workflow to a project.`,
				);
			}
			continue;
		}
		const refusal = await refusalFor(projectId);
		if (refusal) {
			problems.push(`${nodeName(node)}: ${refusal}`);
		}
	}
	return problems;
}

export interface AgenticPublishCheck {
	problems: string[];
	/** The MCP servers the graph's agent tasks name that are the owner's own. */
	mcpServers: ResolvedMcpServer[];
}

/**
 * Problems that keep a graph with agent tasks, story reviews or frame publishing from going
 * live. A scheduled agent runs unattended, so everything it may do is settled
 * here, before the schedule exists. Returns no problems when the graph has no
 * agentic nodes or every node is valid.
 *
 * Besides each node's own config, an agent task is held to: a schedule that
 * runs no more often than the minimum interval; MCP servers that are the
 * owner's own in this organization; and built-in capabilities an unattended
 * agent may hold. A publish frame is held to a project the owner may add to. A
 * story review uses the owner's connected project and accessible instructions.
 * A schedule's time zone must be a real one whatever the graph holds.
 *
 * `userId` is the workflow's owner, whose rights the unattended run uses.
 * `projectId` is the workflow's project (null for none), so an artifact that
 * leaves its project to the workflow is checked too.
 */
export async function findAgenticPublishProblems(input: {
	nodes: unknown;
	userId: string;
	organizationId: string | null;
	projectId: string | null;
}): Promise<AgenticPublishCheck> {
	if (!Array.isArray(input.nodes)) {
		return { problems: [], mcpServers: [] };
	}
	const nodes: unknown[] = input.nodes;
	const problems = [
		...scheduleTriggerProblems(nodes),
		...scheduleTimezoneProblems(nodes),
		...workflowScriptProblems(nodes),
		...workflowWorkspaceDataProblems(nodes),
		...workflowNativePlatformReadProblems(nodes),
	];

	const agents: ParsedNode<AgentTaskNodeConfig>[] = [];
	const publishers: ParsedNode<PublishFrameNodeConfig>[] = [];
	const reviews: ParsedNode<AdoStoryReviewConfig>[] = [];
	let hasAgentTask = false;
	let hasReview = false;
	for (const node of nodes as GraphNode[]) {
		if (node?.type === NATIVE_PLATFORM_READ_NODE_TYPE && !input.projectId) {
			problems.push(
				`${nodeName(node)}: native reads require a workflow project`,
			);
		}
		if (node?.type === AGENT_TASK_NODE_TYPE) {
			hasAgentTask = true;
			const parsed = parseConfig(
				node,
				AgentTaskNodeConfigSchema,
				problems,
			);
			if (parsed) {
				agents.push(parsed);
			}
		} else if (node?.type === ADO_STORY_REVIEW_NODE_TYPE) {
			hasReview = true;
			const parsed = parseConfig(
				node,
				adoStoryReviewConfigSchema,
				problems,
			);
			if (parsed) {
				reviews.push(parsed);
			}
		} else if (node?.type === PUBLISH_FRAME_NODE_TYPE) {
			const parsed = parseConfig(
				node,
				PublishFrameNodeConfigSchema,
				problems,
			);
			if (parsed) {
				publishers.push(parsed);
			}
		}
	}

	let mcpServers: ResolvedMcpServer[] = [];
	if (hasAgentTask || hasReview) {
		problems.push(...scheduleIntervalProblems(nodes));
	}
	if (hasAgentTask) {
		problems.push(...builtInCapabilityProblems(agents));
		if (input.organizationId) {
			const checked = await mcpServerChecks(agents, {
				userId: input.userId,
				organizationId: input.organizationId,
			});
			problems.push(...checked.problems);
			mcpServers = checked.servers;
		} else {
			problems.push(
				"Agent tasks run inside an organization; this workflow has none.",
			);
		}
	}
	problems.push(
		...(await adoStoryReviewPublishProblems(
			reviews.map(({ node, config }) => ({
				name: nodeName(node),
				config,
			})),
			input,
		)),
	);
	problems.push(...(await frameProjectProblems(publishers, input)));
	return { problems, mcpServers };
}
