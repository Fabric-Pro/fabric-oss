/**
 * Tests for the lifecycle-signal helpers.
 *
 * Asserts the best-effort contract: when Temporal throws, the helper
 * swallows the error rather than bubbling up. This is the source of the
 * "DB write is the source of truth" guarantee documented in the
 * acknowledge / resolve procedures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetTemporalClient } = vi.hoisted(() => ({
	mockGetTemporalClient: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: (...args: unknown[]) => mockGetTemporalClient(...args),
}));

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
});

describe("signalIncidentAcknowledged", () => {
	it("signals the lifecycle workflow with deterministic ID", async () => {
		const signal = vi.fn().mockResolvedValue(undefined);
		const getHandle = vi.fn().mockReturnValue({ signal });
		mockGetTemporalClient.mockResolvedValue({
			workflow: { getHandle },
		});

		const { signalIncidentAcknowledged } = await import(
			"../lifecycle-signal"
		);
		await signalIncidentAcknowledged({
			incidentId: "inc-1",
			userId: "u-1",
			note: "ack",
		});

		expect(getHandle).toHaveBeenCalledWith("incident-inc-1");
		expect(signal).toHaveBeenCalledWith("acknowledged", {
			userId: "u-1",
			note: "ack",
		});
	});

	it("swallows errors when Temporal is unreachable", async () => {
		mockGetTemporalClient.mockRejectedValue(new Error("conn refused"));
		const { signalIncidentAcknowledged } = await import(
			"../lifecycle-signal"
		);
		await expect(
			signalIncidentAcknowledged({ incidentId: "inc-9", userId: "u-1" }),
		).resolves.toBeUndefined();
	});
});

describe("signalIncidentResolved", () => {
	it("signals the lifecycle workflow with the resolved signal", async () => {
		const signal = vi.fn().mockResolvedValue(undefined);
		const getHandle = vi.fn().mockReturnValue({ signal });
		mockGetTemporalClient.mockResolvedValue({
			workflow: { getHandle },
		});

		const { signalIncidentResolved } = await import("../lifecycle-signal");
		await signalIncidentResolved({
			incidentId: "inc-2",
			userId: "u-2",
			reason: "MANUAL_RESOLVED",
		});

		expect(getHandle).toHaveBeenCalledWith("incident-inc-2");
		expect(signal).toHaveBeenCalledWith("resolved", {
			userId: "u-2",
			reason: "MANUAL_RESOLVED",
		});
	});

	it("swallows errors when the signal throws", async () => {
		const signal = vi.fn().mockRejectedValue(new Error("not running"));
		const getHandle = vi.fn().mockReturnValue({ signal });
		mockGetTemporalClient.mockResolvedValue({
			workflow: { getHandle },
		});
		const { signalIncidentResolved } = await import("../lifecycle-signal");
		await expect(
			signalIncidentResolved({ incidentId: "inc-9", reason: "x" }),
		).resolves.toBeUndefined();
	});
});
