import { describe, expect, it } from "vitest";
import { formatMessageTimestamp } from "../formatMessageTimestamp";

/**
 * `now` is fixed so the relative-label branches are deterministic. The
 * timezone-sensitive assertions deliberately compare against the platform's
 * own `toLocaleString` output (computed in-test with the same options) so the
 * suite is correct in CI regardless of the runner's TZ — what we assert is
 * that the tooltip is the LOCAL human string, never the UTC `…Z` ISO.
 */
const NOW = new Date("2026-05-31T12:00:00.000Z");

const LOCAL_OPTS: Intl.DateTimeFormatOptions = {
	year: "numeric",
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	timeZoneName: "short",
};

describe("formatMessageTimestamp", () => {
	it("returns null for missing / unparseable input", () => {
		expect(formatMessageTimestamp({})).toBeNull();
		expect(formatMessageTimestamp({ timestamp: null })).toBeNull();
		expect(formatMessageTimestamp({ createdAt: undefined })).toBeNull();
		expect(formatMessageTimestamp({ timestamp: "not-a-date" })).toBeNull();
	});

	it("prefers `timestamp` over `createdAt`", () => {
		const r = formatMessageTimestamp(
			{
				timestamp: "2026-05-31T11:59:00.000Z",
				createdAt: "2020-01-01T00:00:00.000Z",
			},
			NOW,
		);
		expect(r?.label).toBe("1m ago");
	});

	describe("label branches", () => {
		it('"just now" under 45s', () => {
			expect(
				formatMessageTimestamp(
					{ timestamp: "2026-05-31T11:59:30.000Z" },
					NOW,
				)?.label,
			).toBe("just now");
		});
		it('"Nm ago" under an hour', () => {
			expect(
				formatMessageTimestamp(
					{ timestamp: "2026-05-31T11:45:00.000Z" },
					NOW,
				)?.label,
			).toBe("15m ago");
		});
		it('"Nh ago" under 18h', () => {
			expect(
				formatMessageTimestamp(
					{ timestamp: "2026-05-31T06:00:00.000Z" },
					NOW,
				)?.label,
			).toBe("6h ago");
		});
	});

	describe("iso — machine-readable, intentionally UTC", () => {
		it("is the UTC ISO of the instant (for the <time dateTime> attribute)", () => {
			const r = formatMessageTimestamp(
				{ timestamp: "2026-05-31T06:00:00.000Z" },
				NOW,
			);
			expect(r?.iso).toBe("2026-05-31T06:00:00.000Z");
		});
	});

	describe("tooltip — human-readable, LOCAL timezone (the bug fix)", () => {
		const when = "2026-05-31T06:00:00.000Z";

		it("is NOT the raw UTC ISO zulu string", () => {
			const r = formatMessageTimestamp({ timestamp: when }, NOW);
			expect(r?.tooltip).not.toBe(r?.iso);
			// Must read like wall-clock text, not an ISO-8601 instant.
			expect(r?.tooltip).not.toMatch(/\dT\d/);
			expect(r?.tooltip).not.toMatch(/Z$/);
		});

		it("matches the platform's LOCAL toLocaleString for that instant", () => {
			const r = formatMessageTimestamp({ timestamp: when }, NOW);
			expect(r?.tooltip).toBe(
				new Date(when).toLocaleString(undefined, LOCAL_OPTS),
			);
		});

		it("is present on every label branch (computed once, shared)", () => {
			for (const ts of [
				"2026-05-31T11:59:30.000Z", // just now
				"2026-05-31T11:45:00.000Z", // 15m ago
				"2026-05-31T06:00:00.000Z", // 6h ago
				"2026-05-20T06:00:00.000Z", // dated label (prev days)
				"2024-01-02T06:00:00.000Z", // prior calendar year
			]) {
				const r = formatMessageTimestamp({ timestamp: ts }, NOW);
				expect(r?.tooltip).toBe(
					new Date(ts).toLocaleString(undefined, LOCAL_OPTS),
				);
			}
		});
	});
});
