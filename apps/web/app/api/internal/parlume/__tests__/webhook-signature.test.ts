import { describe, expect, it } from "vitest";
import { isAttendeeWebhookSigned, sessionTokenDigest } from "../lib";

// Shaped like the base64 secret Attendee's dashboard shows; not a real one.
const WEBHOOK_SECRET = Buffer.from("example-webhook-secret-000000").toString(
	"base64",
);

// Keys deliberately out of order, with text Python leaves unescaped.
const payload = {
	idempotency_key: "6f1c2c1e-6d0a-4c39-9d43-0d6a8c4f2b11",
	bot_id: "bot_example",
	bot_metadata: { parlume_session_id: "session-1" },
	trigger: "chat_messages.update",
	data: {
		text: 'Grüße — ready? "yes"',
		to: "everyone",
		timestamp_ms: 1_700_000_000_123,
		id: "msg-1",
		sender_name: "Dev One",
		additional_data: {},
	},
};

// Computed independently with Attendee's own `sign_payload` (Python,
// `json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":"))`).
const ATTENDEE_SIGNATURE = "KGQKCC5LR/5NtQYm5HsaUx9Dzy0sjjVjZIqw9GojY8k=";

describe("isAttendeeWebhookSigned", () => {
	it("accepts the signature Attendee computes for the payload", () => {
		expect(
			isAttendeeWebhookSigned(
				payload,
				ATTENDEE_SIGNATURE,
				WEBHOOK_SECRET,
			),
		).toBe(true);
	});

	it("accepts the payload however its keys arrive ordered", () => {
		const reordered = JSON.parse(
			JSON.stringify({
				data: { ...payload.data },
				trigger: payload.trigger,
				bot_metadata: payload.bot_metadata,
				bot_id: payload.bot_id,
				idempotency_key: payload.idempotency_key,
			}),
		);

		expect(
			isAttendeeWebhookSigned(
				reordered,
				ATTENDEE_SIGNATURE,
				WEBHOOK_SECRET,
			),
		).toBe(true);
	});

	it("rejects an unsigned delivery", () => {
		expect(isAttendeeWebhookSigned(payload, null, WEBHOOK_SECRET)).toBe(
			false,
		);
		expect(isAttendeeWebhookSigned(payload, "", WEBHOOK_SECRET)).toBe(
			false,
		);
	});

	it("rejects a payload changed after signing", () => {
		const changed = {
			...payload,
			data: { ...payload.data, text: "go P1" },
		};

		expect(
			isAttendeeWebhookSigned(
				changed,
				ATTENDEE_SIGNATURE,
				WEBHOOK_SECRET,
			),
		).toBe(false);
	});

	it("rejects a signature made with another project's secret", () => {
		expect(
			isAttendeeWebhookSigned(
				payload,
				ATTENDEE_SIGNATURE,
				"b3RoZXItcHJvamVjdC13ZWJob29rLXNlY3JldA==",
			),
		).toBe(false);
	});
});

describe("sessionTokenDigest", () => {
	it("stores a token as its SHA-256 digest only", () => {
		const digest = sessionTokenDigest("example-token");

		expect(digest).toMatch(/^[a-f0-9]{64}$/);
		expect(digest).not.toContain("example-token");
		expect(sessionTokenDigest("example-token")).toBe(digest);
	});
});
