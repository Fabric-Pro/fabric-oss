import type { DeliverySourceCaptureInput } from "@repo/temporal/delivery-source-capture-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ page: vi.fn(), purge: vi.fn(), proxy: vi.fn() }));
vi.mock("@temporalio/workflow", () => ({
	ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "wait" },
	workflowInfo: () => ({ workflowId: "example-native-workflow" }),
	proxyActivities: (options: unknown) => {
		m.proxy(options);
		return {
			captureDeliverySourcePageActivity: m.page,
			purgeExpiredDeliverySourceObservationsActivity: m.purge,
		};
	},
}));

import {
	deliverySourceCaptureWorkflow,
	deliverySourceObservationRetentionWorkflow,
} from "../delivery-source-capture";

const input: DeliverySourceCaptureInput = {
	organizationId: "example-org",
	projectId: "example-project",
	userId: "example-user",
	watchId: "example-watch",
	configVersion: 2,
	grantRevision: 1,
	mode: "RECENT",
};
beforeEach(() => {
	m.page.mockReset();
	m.purge.mockReset();
});
describe("finite source capture orchestration", () => {
	it("uses native workflow identity and monotonically indexed pages, then stops at exhaustion", async () => {
		m.page
			.mockResolvedValueOnce({
				captured: 2,
				hasMore: true,
				coverage: "ROOT_MESSAGES_ONLY",
			})
			.mockResolvedValueOnce({
				captured: 3,
				hasMore: false,
				coverage: "ROOT_MESSAGES_ONLY",
			});
		expect(await deliverySourceCaptureWorkflow(input)).toEqual({
			captured: 5,
			hasMore: false,
			coverage: "ROOT_MESSAGES_ONLY",
		});
		expect(m.page.mock.calls.map(([value]) => value)).toEqual([
			{ ...input, workflowId: "example-native-workflow", pageIndex: 0 },
			{ ...input, workflowId: "example-native-workflow", pageIndex: 1 },
		]);
	});
	it("caps each run at five pages and reports partial coverage when more remain", async () => {
		m.page.mockResolvedValue({
			captured: 50,
			hasMore: true,
			coverage: "ROOT_MESSAGES_ONLY",
		});
		expect(await deliverySourceCaptureWorkflow(input)).toEqual({
			captured: 250,
			hasMore: true,
			coverage: "PARTIAL",
		});
		expect(m.page).toHaveBeenCalledTimes(5);
		expect(m.page.mock.calls.map(([value]) => value.pageIndex)).toEqual([
			0, 1, 2, 3, 4,
		]);
	});
	it("retains a partial page verdict even when a later page exhausts the window", async () => {
		m.page
			.mockResolvedValueOnce({
				captured: 0,
				hasMore: true,
				coverage: "PARTIAL",
			})
			.mockResolvedValueOnce({
				captured: 1,
				hasMore: false,
				coverage: "ROOT_MESSAGES_ONLY",
			});
		expect((await deliverySourceCaptureWorkflow(input)).coverage).toBe(
			"PARTIAL",
		);
	});
	it("does not forward extra untrusted content or credentials into activity arguments", async () => {
		m.page.mockResolvedValue({
			captured: 0,
			hasMore: false,
			coverage: "ROOT_MESSAGES_ONLY",
			privateText: "example-private-text",
		});
		const result = await deliverySourceCaptureWorkflow({
			...input,
			text: "example-private-text",
			token: "example-secret",
		} as DeliverySourceCaptureInput);
		expect(JSON.stringify(m.page.mock.calls)).not.toMatch(
			/example-private-text|example-secret/,
		);
		expect(Object.keys(result).sort()).toEqual([
			"captured",
			"coverage",
			"hasMore",
		]);
	});
	it("propagates native failure/cancellation without starting another page", async () => {
		const failure = new Error("Example sanitized activity failure");
		m.page.mockRejectedValue(failure);
		await expect(deliverySourceCaptureWorkflow(input)).rejects.toBe(
			failure,
		);
		expect(m.page).toHaveBeenCalledTimes(1);
	});
	it("has an independent bounded retention workflow without triggering source reads", async () => {
		m.purge.mockResolvedValue({
			deletedCount: 500,
			batches: 2,
			hitSafetyCap: false,
		});
		expect(await deliverySourceObservationRetentionWorkflow()).toEqual({
			deletedCount: 500,
			batches: 2,
			hitSafetyCap: false,
		});
		expect(m.page).not.toHaveBeenCalled();
	});
});

it("forwards only explicit bounded-history metadata for the new mode", async () => {
	m.page.mockResolvedValue({
		captured: 0,
		hasMore: false,
		coverage: "ROOT_MESSAGES_ONLY",
	});
	const window = {
		start: "2026-10-05T00:00:00.000Z",
		end: "2026-10-07T00:00:00.000Z",
	};
	await deliverySourceCaptureWorkflow({ ...input, mode: "BACKFILL", window });
	expect(m.page.mock.calls[0][0]).toEqual({
		...input,
		mode: "BACKFILL",
		window,
		workflowId: "example-native-workflow",
		pageIndex: 0,
	});
});
