/**
 * LLM model resolution tests
 *
 * resolveReaderModel is a thin wrapper around @repo/ai's
 * getAIModelWithMetadata, but the exact arguments it forwards are load
 * bearing: taskType selects the model tier, and the "weave-reader" jobType
 * label is what lets the usage interceptor attribute tokens correctly
 * (Fizzy #1894). A silent regression here (e.g. dropping jobType, or
 * forwarding organizationId as null instead of undefined) would not throw —
 * it would just misattribute usage. Pin the call contract directly.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { resolveReaderModel } from "./llm.js";

const getAIModelWithMetadata = vi.fn();

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...args: unknown[]) =>
		getAIModelWithMetadata(...args),
}));

describe("resolveReaderModel", () => {
	afterEach(() => {
		vi.resetAllMocks();
	});

	it("requests the CHAT task type with the weave-reader job label", async () => {
		const fakeModel = { modelId: "fake" };
		getAIModelWithMetadata.mockResolvedValue({ model: fakeModel });

		const model = await resolveReaderModel({
			userId: "user-1",
			organizationId: "org-1",
		});

		assert.equal(model, fakeModel);
		assert.equal(getAIModelWithMetadata.mock.calls.length, 1);
		const [taskArg, contextArg] = getAIModelWithMetadata.mock.calls[0];
		assert.deepEqual(taskArg, { taskType: "CHAT" });
		assert.deepEqual(contextArg, {
			userId: "user-1",
			organizationId: "org-1",
			jobType: "weave-reader",
		});
	});

	it("forwards organizationId as undefined when the tenant has none", async () => {
		getAIModelWithMetadata.mockResolvedValue({ model: {} });

		await resolveReaderModel({ userId: "user-1", organizationId: null });

		const [, contextArg] = getAIModelWithMetadata.mock.calls[0];
		assert.equal(contextArg.organizationId, undefined);
	});

	it("forwards organizationId as undefined when the tenant omits it entirely", async () => {
		getAIModelWithMetadata.mockResolvedValue({ model: {} });

		await resolveReaderModel({ userId: "user-1" });

		const [, contextArg] = getAIModelWithMetadata.mock.calls[0];
		assert.equal(contextArg.organizationId, undefined);
	});
});
