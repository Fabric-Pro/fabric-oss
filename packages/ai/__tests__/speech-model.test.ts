import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn(),
	waitUntil: vi.fn(),
	updateLastUsed: vi.fn(),
	billing: vi.fn(),
	speechModel: vi.fn(),
	resolveKey: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));

vi.mock("@repo/database", () => ({
	getAiProviderApiKeyByProvider: mocks.getConfig,
	updateProviderLastUsed: mocks.updateLastUsed,
}));

vi.mock("@repo/payments", () => ({
	getTenantAiGatewayBillingState: mocks.billing,
}));

vi.mock("../model-factory", () => ({
	getGatewaySpeechModel: mocks.speechModel,
}));

vi.mock("../lib/databricks-oauth", () => ({
	resolveProviderApiKey: mocks.resolveKey,
}));

import { GATEWAY_SPEECH_MODEL_ID, getAISpeechModel } from "../lib/speech-model";

const context = { userId: "user-1", organizationId: "org-1" };

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getConfig.mockResolvedValue({
		provider: "VERCEL_GATEWAY",
		source: "organization",
		apiKey: "encrypted-gateway-key",
		configId: "gateway-config",
	});
	mocks.resolveKey.mockResolvedValue("gateway-key");
	mocks.billing.mockReturnValue({ mode: "external_provider", headers: null });
	mocks.speechModel.mockReturnValue({ modelId: GATEWAY_SPEECH_MODEL_ID });
	mocks.updateLastUsed.mockResolvedValue(undefined);
});

describe("getAISpeechModel", () => {
	it("builds the gateway speech model from the organization's own gateway credential", async () => {
		const result = await getAISpeechModel(context);

		expect(mocks.getConfig).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			provider: "VERCEL_GATEWAY",
		});
		expect(mocks.speechModel).toHaveBeenCalledWith(
			GATEWAY_SPEECH_MODEL_ID,
			{
				apiKey: "gateway-key",
				headers: undefined,
			},
		);
		expect(result?.modelId).toBe("openai/tts-1");

		expect(result?.trackUsage()).toBeUndefined();
		expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
		await expect(mocks.waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
		expect(mocks.updateLastUsed).toHaveBeenCalledWith({
			configId: "gateway-config",
			source: "organization",
		});
	});

	it("registers the pending bump without waiting and handles a failed write", async () => {
		let rejectWrite!: (reason: Error) => void;
		mocks.updateLastUsed.mockReturnValue(
			new Promise<void>((_resolve, reject) => {
				rejectWrite = reject;
			}),
		);
		const result = await getAISpeechModel(context);

		expect(result?.trackUsage()).toBeUndefined();
		expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
		const registered = mocks.waitUntil.mock.calls[0][0];
		rejectWrite(new Error("example write failure"));
		await expect(registered).resolves.toBeUndefined();
	});

	it.each([
		["no gateway provider", { provider: null, source: null, apiKey: null }],
		[
			"a platform gateway rather than the organization's",
			{
				provider: "VERCEL_GATEWAY",
				source: null,
				apiKey: "platform-key",
			},
		],
		[
			"a gateway provider without a key",
			{
				provider: "VERCEL_GATEWAY",
				source: "organization",
				apiKey: null,
			},
		],
	])(
		"returns null for %s, so the caller can use another route",
		async (_label, config) => {
			mocks.getConfig.mockResolvedValue({ configId: null, ...config });

			await expect(getAISpeechModel(context)).resolves.toBeNull();
			expect(mocks.speechModel).not.toHaveBeenCalled();
			expect(mocks.resolveKey).not.toHaveBeenCalled();
		},
	);
});
