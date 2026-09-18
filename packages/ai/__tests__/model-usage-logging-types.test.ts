import { describe, expect, expectTypeOf, it } from "vitest";
import {
	type AIOperationContext,
	type GetAIModelOptions,
	getAIModel,
	getAIModelWithMetadata,
} from "../index";

const context: AIOperationContext = { userId: "u1" };

const ordinaryOptions = { taskType: "CHAT" } satisfies GetAIModelOptions;

// Aggregate logging is deliberately unavailable to the plain model helper.
// @ts-expect-error Aggregate logging requires getAIModelWithMetadata.
const invalidPlainModelOptions: GetAIModelOptions = {
	taskType: "CHAT",
	usageLogging: "aggregate",
};
void invalidPlainModelOptions;

async function assertResolverResultTypes() {
	// @ts-expect-error Plain getAIModel cannot disable its automatic middleware.
	getAIModel({ taskType: "CHAT", usageLogging: "aggregate" }, context);

	const ordinary = await getAIModelWithMetadata(ordinaryOptions, context);
	// @ts-expect-error Per-call model resolution must not expose a manual writer.
	ordinary.recordAggregateUsage;

	const aggregate = await getAIModelWithMetadata(
		{ taskType: "CHAT", usageLogging: "aggregate" },
		context,
	);
	expectTypeOf(aggregate.recordAggregateUsage).toBeFunction();
}
describe("model usage logging type boundaries", () => {
	it("keeps aggregate logging metadata-only", () => {
		void assertResolverResultTypes;
		expectTypeOf(ordinaryOptions).toMatchTypeOf<GetAIModelOptions>();
		expect(true).toBe(true);
	});
});
