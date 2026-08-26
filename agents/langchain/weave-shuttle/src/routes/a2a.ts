import { Hono } from "hono";
import { startWeaveCodingRunAndWait } from "../lib/coding-run-bridge.js";
import { extractText } from "../lib/route-utils.js";

export const a2aRoute = new Hono();

a2aRoute.post("/send", async (c) => {
	const taskId = crypto.randomUUID();

	try {
		const body = (await c.req.json()) as Record<string, unknown>;
		const prompt = extractText(body.message);
		const metadata = (body.metadata ?? {}) as Record<string, unknown>;
		const delegationContext = (metadata.delegationContext ??
			metadata) as Record<string, unknown>;
		const stepInputs = (delegationContext.stepInputs ?? {}) as Record<
			string,
			unknown
		>;
		const planId =
			typeof stepInputs.weavePlanId === "string"
				? stepInputs.weavePlanId
				: "";
		const category =
			typeof stepInputs.category === "string"
				? stepInputs.category
				: "backend";
		const modelOverride =
			typeof stepInputs.modelOverride === "string"
				? stepInputs.modelOverride
				: undefined;

		if (!planId) {
			return c.json(
				{
					task: {
						id: taskId,
						status: "failed",
						messages: [
							{
								role: "agent",
								parts: [
									{
										type: "text",
										text: "Shuttle requires weavePlanId to start a coding run.",
									},
								],
							},
						],
					},
				},
				400,
			);
		}

		// Extract verified tenant from middleware (falls back to headers for compat)
		const verifiedTenant = (
			c as unknown as { get(key: string): unknown }
		).get("tenant") as
			| { userId: string; organizationId: string | null }
			| undefined;
		const userId =
			verifiedTenant?.userId ||
			c.req.raw.headers.get("X-Tenant-User-ID") ||
			"";
		const organizationId =
			verifiedTenant?.organizationId ??
			c.req.raw.headers.get("X-Tenant-Organization-ID");

		// Extract project context from delegation metadata
		const projectContext = (metadata.projectContext ??
			delegationContext.projectContext) as
			| Record<string, unknown>
			| undefined;

		const result = await startWeaveCodingRunAndWait({
			planId,
			prompt,
			category,
			modelOverride,
			userId,
			organizationId,
			projectContext: projectContext
				? {
						projectName:
							typeof projectContext.projectName === "string"
								? projectContext.projectName
								: undefined,
						techStack:
							typeof projectContext.techStack === "string"
								? projectContext.techStack
								: undefined,
						description:
							typeof projectContext.description === "string"
								? projectContext.description
								: undefined,
					}
				: undefined,
		});

		const text = [
			"## Shuttle coding run bridge",
			"",
			`Coding run: ${result.codingRunId}`,
			`Workflow: ${result.workflowId}`,
			`Status: ${result.status}`,
			result.pullRequestUrl
				? `Pull request: ${result.pullRequestUrl}`
				: undefined,
			"",
			result.summary,
		]
			.filter(Boolean)
			.join("\n");

		return c.json({
			task: {
				id: taskId,
				status: result.status === "failed" ? "failed" : "completed",
				messages: [{ role: "agent", parts: [{ type: "text", text }] }],
				artifacts: result.pullRequestUrl
					? [
							{
								id: `pr-${result.codingRunId}`,
								name: "pull_request",
								mimeType: "text/plain",
								parts: [
									{
										type: "text",
										text: result.pullRequestUrl,
									},
								],
							},
						]
					: undefined,
			},
		});
	} catch (error) {
		return c.json(
			{
				task: {
					id: taskId,
					status: "failed",
					messages: [
						{
							role: "agent",
							parts: [
								{
									type: "text",
									text: `Shuttle error: ${error instanceof Error ? error.message : "Unknown error"}`,
								},
							],
						},
					],
				},
			},
			500,
		);
	}
});
