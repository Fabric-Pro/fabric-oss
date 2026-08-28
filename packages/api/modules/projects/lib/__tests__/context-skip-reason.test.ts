/**
 * Unit tests for the export skip-reason taxonomy (Fizzy #2228, U4).
 *
 * The function under test takes no database or storage handle, so every
 * branch is reachable from a hand-built row. One case per reason, asserted
 * against the pure function — that is the whole point of extracting it: the
 * taxonomy is provable without standing up an archive.
 */

import { describe, expect, it } from "vitest";
import {
	CONTEXT_SKIP_REASON_CODES,
	type ContextSkipReason,
	countContextSkipReasons,
	deriveContextSkipReason,
	deriveStorageErrorSkipReason,
	describeContextSkipReason,
	emptyContextSkipReasonCounts,
} from "../context-skip-reason";

function row(
	partial: Partial<
		Parameters<typeof deriveContextSkipReason>[0]["context"]
	> = {},
) {
	return {
		type: "TEXT",
		s3Path: null,
		urlScope: null,
		extractionStatus: null,
		metadata: null,
		...partial,
	};
}

/**
 * One sample reason per code, for the walks that must render all of them.
 * The payload-carrying codes are named explicitly; everything else is a bare
 * `{ code }`. The cast is why the walks also assert no line contains
 * "undefined" — that guard, not the type system, is what catches a future
 * payload-carrying code being added here without its payload.
 */
function sampleReason(
	code: (typeof CONTEXT_SKIP_REASON_CODES)[number],
): ContextSkipReason {
	if (
		code === "CONVERSATION_NOT_CAPTURED" ||
		code === "PRIVATE_CONVERSATION_EXCLUDED"
	) {
		return { code, sourceSystem: "Slack" };
	}
	return { code } as ContextSkipReason;
}

describe("deriveContextSkipReason — nothing stored", () => {
	it("reports a Class A row with no recorded object as nothing stored", () => {
		expect(
			deriveContextSkipReason({
				context: row({ type: "FILE", s3Path: null }),
				downloadClass: "A",
				exportText: "",
			}),
		).toEqual({ code: "NOTHING_STORED" });
	});

	it("reports an empty text row with no other explanation as nothing stored", () => {
		expect(
			deriveContextSkipReason({
				context: row({ type: "TEXT" }),
				downloadClass: "B",
				exportText: "",
			}),
		).toEqual({ code: "NOTHING_STORED" });
	});

	it("does not claim finality for a row still being extracted", () => {
		// PENDING / EXTRACTING are not terminal, so the reason must describe
		// what is true now — nothing is stored — without asserting an outcome.
		for (const extractionStatus of ["PENDING", "EXTRACTING"]) {
			const reason = deriveContextSkipReason({
				context: row({ type: "LINK", extractionStatus }),
				downloadClass: "B",
				exportText: "",
			});
			expect(reason).toEqual({ code: "NOTHING_STORED" });
			expect(describeContextSkipReason(reason as ContextSkipReason)).toBe(
				"No content stored for this item",
			);
		}
	});
});

describe("deriveContextSkipReason — terminal extraction states", () => {
	it("reports a terminally failed row without describing it as processing", () => {
		const reason = deriveContextSkipReason({
			context: row({ type: "LINK", extractionStatus: "FAILED" }),
			downloadClass: "B",
			exportText: "",
		});

		expect(reason).toEqual({ code: "EXTRACTION_FAILED" });

		const text = describeContextSkipReason(reason as ContextSkipReason);
		expect(text).toContain("failed");
		// The blended string this taxonomy replaces called every skip
		// "still processing or unavailable". A terminal failure is neither.
		expect(text).not.toMatch(/processing|pending|not ready|in progress/i);
	});

	it("reports a cancelled extraction as cancelled, not as a failure", () => {
		const reason = deriveContextSkipReason({
			context: row({ type: "LINK", extractionStatus: "CANCELLED" }),
			downloadClass: "B",
			exportText: "",
		});

		expect(reason).toEqual({ code: "EXTRACTION_CANCELLED" });
		expect(
			describeContextSkipReason(reason as ContextSkipReason),
		).toContain("cancelled");
	});
});

describe("deriveContextSkipReason — linked conversations", () => {
	it("names Microsoft Teams for a linked channel with nothing captured", () => {
		const reason = deriveContextSkipReason({
			context: row({
				type: "INTEGRATION",
				metadata: {
					provider: "MICROSOFT_TEAMS",
					chatType: "channel",
					teamId: "team-1",
					channelId: "channel-1",
					title: "Delivery - general",
				},
			}),
			downloadClass: "B",
			exportText: "",
		});

		expect(reason).toEqual({
			code: "CONVERSATION_NOT_CAPTURED",
			sourceSystem: "Microsoft Teams",
		});
		expect(describeContextSkipReason(reason as ContextSkipReason)).toBe(
			"Linked Microsoft Teams conversation — no messages captured yet",
		);
	});

	it("names Slack for a linked channel with nothing captured", () => {
		const reason = deriveContextSkipReason({
			context: row({
				type: "INTEGRATION",
				metadata: {
					provider: "SLACK",
					channelId: "C123",
					channelName: "delivery",
					title: "#delivery",
				},
			}),
			downloadClass: "B",
			exportText: "",
		});

		expect(reason).toEqual({
			code: "CONVERSATION_NOT_CAPTURED",
			sourceSystem: "Slack",
		});
		expect(describeContextSkipReason(reason as ContextSkipReason)).toBe(
			"Linked Slack conversation — no messages captured yet",
		);
	});

	it("tells a one-to-one or group chat it will never be captured, without saying 'yet'", () => {
		// The capture path monitors shared channels only — a project is a
		// wider audience than a private conversation. "No messages captured
		// yet" promises these rows something that will never arrive, which is
		// the exact wording the ticket's AC1 rules out.
		for (const chatType of ["group", "oneOnOne"]) {
			const reason = deriveContextSkipReason({
				context: row({
					type: "INTEGRATION",
					metadata: {
						provider: "MICROSOFT_TEAMS",
						chatType,
						chatId: "chat-1",
						chatTopic: "Delivery sync",
						title: "Delivery sync",
					},
				}),
				downloadClass: "B",
				exportText: "",
			});

			expect(reason).toEqual({
				code: "PRIVATE_CONVERSATION_EXCLUDED",
				sourceSystem: "Microsoft Teams",
			});

			const text = describeContextSkipReason(reason as ContextSkipReason);
			expect(text).toBe(
				"Linked Microsoft Teams chat — one-to-one and group chats are not captured by design; their messages stay in Microsoft Teams",
			);
			// The load-bearing assertion. "yet" is the single word that turns
			// a permanent exclusion back into a promise.
			expect(text).not.toMatch(/\byet\b/i);
		}
	});

	it("keeps a captured conversation exportable", () => {
		expect(
			deriveContextSkipReason({
				context: row({
					type: "INTEGRATION",
					metadata: { provider: "SLACK", channelId: "C123" },
				}),
				downloadClass: "B",
				exportText: "## Thread\n\nsomething was captured",
			}),
		).toBeNull();
	});

	it("does not call an unrecognized integration a conversation", () => {
		// Guessing at a source system would trade a vague lie for a confident
		// one, so an integration the taxonomy does not recognize falls back.
		expect(
			deriveContextSkipReason({
				context: row({
					type: "INTEGRATION",
					metadata: { provider: "NOTION", pageId: "abc" },
				}),
				downloadClass: "B",
				exportText: "",
			}),
		).toEqual({ code: "NOTHING_STORED" });
	});

	it("does not call a chat-provider row without a conversation id a conversation", () => {
		expect(
			deriveContextSkipReason({
				context: row({
					type: "INTEGRATION",
					metadata: { provider: "SLACK", fileId: "F123" },
				}),
				downloadClass: "B",
				exportText: "",
			}),
		).toEqual({ code: "NOTHING_STORED" });
	});
});

describe("deriveContextSkipReason — crawled links", () => {
	it("reports a PATH_PREFIX link whose crawl indexed nothing", () => {
		const reason = deriveContextSkipReason({
			context: row({ type: "LINK", urlScope: "PATH_PREFIX" }),
			downloadClass: "B",
			exportText: "",
		});

		expect(reason).toEqual({ code: "CRAWL_INDEXED_NO_PAGES" });
		expect(describeContextSkipReason(reason as ContextSkipReason)).toBe(
			"Crawl indexed no pages",
		);
	});

	it("keeps a crawl that produced markdown exportable", () => {
		expect(
			deriveContextSkipReason({
				context: row({ type: "LINK", urlScope: "PATH_PREFIX" }),
				downloadClass: "B",
				exportText: "# Handbook\n\npage one",
			}),
		).toBeNull();
	});
});

describe("deriveContextSkipReason — exportable rows", () => {
	it("returns null for a Class A row with a recorded object, whatever extraction says", () => {
		expect(
			deriveContextSkipReason({
				context: row({
					type: "FILE",
					s3Path: "projects/p1/report.pdf",
					extractionStatus: "FAILED",
				}),
				downloadClass: "A",
				exportText: "",
			}),
		).toBeNull();
	});

	it("returns null for a Class C row that holds text", () => {
		expect(
			deriveContextSkipReason({
				context: row({ type: "CODE_FILE" }),
				downloadClass: "C",
				exportText: "export function a() {}",
			}),
		).toBeNull();
	});
});

describe("deriveStorageErrorSkipReason", () => {
	it("maps a missing object to its own reason", () => {
		const reason = deriveStorageErrorSkipReason(
			Object.assign(new Error("boom"), { name: "NoSuchKey" }),
		);
		expect(reason).toEqual({ code: "OBJECT_MISSING" });
		expect(describeContextSkipReason(reason)).toBe(
			"Source object not found in storage",
		);
	});

	it("maps an SDK `Code` of NoSuchKey to a missing object too", () => {
		expect(
			deriveStorageErrorSkipReason(
				Object.assign(new Error("boom"), { Code: "NoSuchKey" }),
			),
		).toEqual({ code: "OBJECT_MISSING" });
	});

	it("maps any other read failure to a read failure", () => {
		const reason = deriveStorageErrorSkipReason(
			new Error("socket hang up"),
		);
		expect(reason).toEqual({ code: "STORAGE_READ_FAILED" });
		expect(describeContextSkipReason(reason)).toBe("Storage read failed");
	});
});

describe("describeContextSkipReason", () => {
	it("renders the ceiling remainder as a truncation, not a failure", () => {
		const text = describeContextSkipReason({ code: "BEYOND_ITEM_LIMIT" });
		expect(text).toBe(
			"Beyond the batch item limit — download this one individually",
		);
		expect(text).not.toMatch(/processing|unavailable|failed/i);
	});

	it("gives every reason its own distinct line", () => {
		const lines = CONTEXT_SKIP_REASON_CODES.map((code) =>
			describeContextSkipReason(sampleReason(code)),
		);
		expect(new Set(lines).size).toBe(CONTEXT_SKIP_REASON_CODES.length);
		// "Context not ready" was the one reason U1 made unreachable; it must
		// not come back through the taxonomy that replaced it.
		expect(lines).not.toContain("Context not ready");
		// The walk builds its samples through a cast, so a NEW reason that
		// carries a payload would otherwise render `Linked undefined chat`
		// and still pass the distinctness check above. This is the assertion
		// that makes such a gap report itself.
		for (const line of lines) {
			expect(line).not.toMatch(/undefined/);
		}
	});
});

describe("countContextSkipReasons", () => {
	it("zero-fills every code so counts are always safe to read", () => {
		const counts = emptyContextSkipReasonCounts();
		for (const code of CONTEXT_SKIP_REASON_CODES) {
			expect(counts[code]).toBe(0);
		}
	});

	it("tallies per reason and sums to the number of skipped rows", () => {
		const reasons: ContextSkipReason[] = [
			{ code: "NOTHING_STORED" },
			{ code: "NOTHING_STORED" },
			{ code: "CONVERSATION_NOT_CAPTURED", sourceSystem: "Slack" },
			{ code: "BEYOND_ITEM_LIMIT" },
			{ code: "EXTRACTION_FAILED" },
		];

		const counts = countContextSkipReasons(reasons);

		expect(counts.NOTHING_STORED).toBe(2);
		expect(counts.CONVERSATION_NOT_CAPTURED).toBe(1);
		expect(counts.BEYOND_ITEM_LIMIT).toBe(1);
		expect(counts.EXTRACTION_FAILED).toBe(1);
		expect(counts.CRAWL_INDEXED_NO_PAGES).toBe(0);
		expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(
			reasons.length,
		);
	});
});
