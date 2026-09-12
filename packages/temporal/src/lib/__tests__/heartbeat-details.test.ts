import { defaultPayloadConverter } from "@temporalio/common";
import { describe, expect, it } from "vitest";
import { decodeHeartbeatDetails } from "../heartbeat-details";

describe("decodeHeartbeatDetails", () => {
	it("decodes the wire-form Payloads that describe() returns", () => {
		const details = {
			phase: "streaming",
			responseText: "Hello",
			toolCalls: [
				{ id: "t1", name: "list_workflows", status: "running" },
			],
		};
		const raw = { payloads: [defaultPayloadConverter.toPayload(details)] };
		expect(decodeHeartbeatDetails<typeof details>(raw)).toEqual(details);
	});

	it("passes through an already-decoded object", () => {
		const details = { phase: "tool_input", toolCalls: [] };
		expect(decodeHeartbeatDetails(details)).toEqual(details);
	});

	it("returns undefined for missing, empty or unreadable details", () => {
		expect(decodeHeartbeatDetails(undefined)).toBeUndefined();
		expect(decodeHeartbeatDetails(null)).toBeUndefined();
		expect(decodeHeartbeatDetails({ payloads: [] })).toBeUndefined();
		expect(
			decodeHeartbeatDetails({
				payloads: [{ metadata: { encoding: Buffer.from("nope") } }],
			}),
		).toBeUndefined();
	});
});
