import {
	ADVISOR_RESULT_MAX_BYTES,
	advisorToolResultStorage,
} from "@repo/database/prisma/queries/advisor-tool-results";
import { logger } from "@repo/logs";
import { Context } from "@temporalio/activity";
// Pure projection shared with the model and its same-answer pager.
import { extractMcpResultText } from "../workflows/orchestrator/advisor-result-read";
import { isLoopBuiltInReadTool } from "../workflows/orchestrator/fabric-catalog-access";
import { resolveFabricCatalogRoute } from "./orchestrator/execution/fabric-catalog-adapter";

/** Optional activity input; absent on calls recorded by earlier workflows. */
export interface AdvisorResultStoreContext {
	toolName: string;
	conversationId: string;
	turnId: string;
	sourceKey: string;
}
const EXCLUDED_TOOLS = new Set([
	"load_skill",
	"read_skill_file",
	"get_tool_schema",
	"search_tools",
	"advisor_result_read",
]);

/** One best-effort attempt at the producing activity, with content-free logs. */
export async function storeAdvisorResult(input: {
	userId: string;
	organizationId?: string;
	advisorResultStore?: AdvisorResultStoreContext;
	toolName: string;
	route: "catalog" | "built-in" | "external";
	result: unknown;
}): Promise<void> {
	const scope = input.advisorResultStore;
	if (
		!scope?.conversationId ||
		!scope.turnId ||
		!scope.sourceKey ||
		!input.organizationId
	) {
		return;
	}
	const name = input.toolName;
	if (EXCLUDED_TOOLS.has(name)) {
		return;
	}
	const declaredRead =
		input.route === "built-in"
			? isLoopBuiltInReadTool(name)
			: input.route === "catalog" &&
				resolveFabricCatalogRoute(name)?.access === "READ";
	if (!declaredRead) {
		return;
	}
	const metadata = {
		userId: input.userId,
		organizationId: input.organizationId,
		conversationId: scope.conversationId,
		turnId: scope.turnId,
		sourceKey: scope.sourceKey,
		toolName: name,
	};
	try {
		const attempt = Context.current().info.attempt;
		const text = extractMcpResultText(input.result);
		const sizeBytes = Buffer.byteLength(text, "utf8");
		const outcome =
			sizeBytes > ADVISOR_RESULT_MAX_BYTES
				? "row_limit"
				: await advisorToolResultStorage.write({
						...metadata,
						attempt,
						text,
					});
		logger.info("[AdvisorResultStore] Write outcome", {
			...metadata,
			attempt,
			sizeBytes,
			outcome,
		});
	} catch {
		// Error messages and result objects can contain tool content or credentials.
		logger.warn("[AdvisorResultStore] Write failed", {
			...metadata,
			outcome: "failed",
		});
	}
}
