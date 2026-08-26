import {
	DEFAULT_ATTACHMENT_MIME_ALLOWLIST,
	DEFAULT_MAX_ATTACHMENT_BYTES,
} from "@repo/utils/attachment";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAttachmentLimits } from "../attachment-limits";

const ENV_KEYS = [
	"FABRIC_ATTACHMENT_MAX_BYTES",
	"FABRIC_ATTACHMENT_MAX_PER_STORY",
	"FABRIC_ATTACHMENT_MIME_ALLOWLIST",
] as const;

beforeEach(() => {
	for (const k of ENV_KEYS) {
		delete process.env[k];
	}
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		delete process.env[k];
	}
});

describe("resolveAttachmentLimits", () => {
	it("returns defaults when no env is set", () => {
		const l = resolveAttachmentLimits();
		expect(l.maxBytes).toBe(DEFAULT_MAX_ATTACHMENT_BYTES);
		expect(l.maxPerStory).toBe(20);
		expect(l.allowlist).toEqual(DEFAULT_ATTACHMENT_MIME_ALLOWLIST);
	});
	it("applies a valid byte override", () => {
		process.env.FABRIC_ATTACHMENT_MAX_BYTES = "10485760";
		expect(resolveAttachmentLimits().maxBytes).toBe(10485760);
	});
	it("clamps an over-2GB override to the ceiling (fail closed)", () => {
		process.env.FABRIC_ATTACHMENT_MAX_BYTES = "9999999999";
		expect(resolveAttachmentLimits().maxBytes).toBe(2_000_000_000);
	});
	it("ignores a garbage byte override and uses the default", () => {
		process.env.FABRIC_ATTACHMENT_MAX_BYTES = "not-a-number";
		expect(resolveAttachmentLimits().maxBytes).toBe(
			DEFAULT_MAX_ATTACHMENT_BYTES,
		);
	});
	it("parses a comma-separated allowlist override", () => {
		process.env.FABRIC_ATTACHMENT_MIME_ALLOWLIST =
			"application/pdf, text/plain";
		expect(resolveAttachmentLimits().allowlist).toEqual([
			"application/pdf",
			"text/plain",
		]);
	});
	it("fails closed on a present-but-empty allowlist env", () => {
		process.env.FABRIC_ATTACHMENT_MIME_ALLOWLIST = "  ,  ";
		expect(resolveAttachmentLimits().allowlist).toEqual([]);
	});
	it("includes the new #1778 default types when the override is unset", () => {
		const { allowlist } = resolveAttachmentLimits();
		expect(allowlist).toContain("text/markdown");
		expect(allowlist).toContain("video/mp4");
		expect(allowlist).toContain("video/webm");
	});
	it("keeps a restrictive override restrictive (does not inject default types)", () => {
		process.env.FABRIC_ATTACHMENT_MIME_ALLOWLIST = "application/pdf";
		const { allowlist } = resolveAttachmentLimits();
		expect(allowlist).toEqual(["application/pdf"]);
		expect(allowlist).not.toContain("text/markdown");
	});
});
