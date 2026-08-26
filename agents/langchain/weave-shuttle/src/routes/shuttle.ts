import { Hono } from "hono";
import { startWeaveCodingRunAndWait } from "../lib/coding-run-bridge.js";
import { extractText, sseTextResponse } from "../lib/route-utils.js";

export const shuttleRoute = new Hono();

shuttleRoute.post("/", async (c) => {
	try {
		const body = await c.req.json();
		const prompt = extractText(body.message);
		const metadata = (body.metadata ?? {}) as Record<string, unknown>;
		const tenantContext = (metadata.tenantContext ?? {}) as Record<
			string,
			unknown
		>;
		const stepInputs = (metadata.stepInputs ?? {}) as Record<
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
				: typeof metadata.category === "string"
					? metadata.category
					: "backend";
		const executionProvider =
			typeof stepInputs.weaveImplementationProvider === "string"
				? stepInputs.weaveImplementationProvider
				: undefined;

		if (!planId) {
			return sseTextResponse(
				"## Shuttle summary\n\nNo weavePlanId was provided, so no coding run could be started.",
			);
		}

		const result = await startWeaveCodingRunAndWait({
			planId,
			prompt,
			category,
			executionProvider:
				executionProvider === "BACKGROUND_AGENTS" ||
				executionProvider === "KANBAN_LOCAL" ||
				executionProvider === "VIBE_WORKSPACE"
					? executionProvider
					: undefined,
			userId:
				typeof tenantContext.userId === "string"
					? tenantContext.userId
					: "",
			organizationId:
				typeof tenantContext.organizationId === "string"
					? tenantContext.organizationId
					: null,
		});

		const lines = [
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
		].filter(Boolean);

		return sseTextResponse(lines.join("\n"));
	} catch (error) {
		return c.json(
			{ error: error instanceof Error ? error.message : "Unknown error" },
			500,
		);
	}
});

shuttleRoute.get("/health", (c) =>
	c.json({
		status: "healthy",
		agent: "shuttle",
		access: "write-enabled",
		capabilities: ["coding-run-bridge"],
	}),
);
