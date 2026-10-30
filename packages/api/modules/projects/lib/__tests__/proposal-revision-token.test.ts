/**
 * The revision token of a finding-driven revision: signed with the server's
 * existing secret, read back only when it is this server's, unexpired, of
 * this purpose and of the expected shape.
 */

import { signToken } from "@repo/auth/lib/signed-token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type RevisionTokenPayload,
	signRevisionToken,
	verifyRevisionToken,
} from "../proposal-revision-token";

const SECRET = "test-secret-at-least-thirty-two-characters-long";

const payload: RevisionTokenPayload = {
	userId: "user_1",
	documentId: "doc_1",
	runId: "run_1",
	findingId: "finding_1",
	baseVersion: 7,
	response: { id: "response_1", version: 2 },
	sectionKey: "p1:pricing#0",
	sectionFingerprint: "hash-of-candidate",
};

beforeEach(() => {
	vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("signRevisionToken / verifyRevisionToken", () => {
	it("round-trips the payload", () => {
		expect(verifyRevisionToken(signRevisionToken(payload))).toEqual(
			payload,
		);
	});

	it("round-trips a revision that started from no answer", () => {
		const none = { ...payload, response: null };
		expect(verifyRevisionToken(signRevisionToken(none))).toEqual(none);
	});

	it("refuses a token whose payload was altered", () => {
		const [head, sig] = signRevisionToken(payload).split(".");
		const body = JSON.parse(Buffer.from(head, "base64url").toString());
		body.p.baseVersion = 8;
		const forged = `${Buffer.from(JSON.stringify(body)).toString("base64url")}.${sig}`;
		expect(verifyRevisionToken(forged)).toBeNull();
	});

	it("refuses a token signed with another secret", () => {
		vi.stubEnv(
			"BETTER_AUTH_SECRET",
			"another-secret-at-least-thirty-two-characters",
		);
		const foreign = signRevisionToken(payload);
		vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
		expect(verifyRevisionToken(foreign)).toBeNull();
	});

	it("refuses a token after thirty minutes", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));
		const token = signRevisionToken(payload);
		vi.setSystemTime(new Date("2026-10-27T10:29:00Z"));
		expect(verifyRevisionToken(token)).toEqual(payload);
		vi.setSystemTime(new Date("2026-10-27T10:31:00Z"));
		expect(verifyRevisionToken(token)).toBeNull();
	});

	it("refuses a token the same secret signed for another purpose", () => {
		const other = signToken(
			{ ...payload, purpose: "fabric-agent-acting-grant" },
			{ ttlSec: 600 },
		);
		expect(verifyRevisionToken(other)).toBeNull();
		const unlabelled = signToken(payload, { ttlSec: 600 });
		expect(verifyRevisionToken(unlabelled)).toBeNull();
	});

	it("refuses a well-signed token of the wrong shape", () => {
		const shaped = (patch: Record<string, unknown>) =>
			signToken(
				{ ...payload, purpose: "fabric-proposal-revision", ...patch },
				{ ttlSec: 600 },
			);
		expect(verifyRevisionToken(shaped({ baseVersion: "7" }))).toBeNull();
		expect(verifyRevisionToken(shaped({ baseVersion: -1 }))).toBeNull();
		expect(verifyRevisionToken(shaped({ userId: "" }))).toBeNull();
		expect(
			verifyRevisionToken(
				shaped({ response: { id: "r", version: "2" } }),
			),
		).toBeNull();
		expect(verifyRevisionToken(shaped({ response: undefined }))).toBeNull();
		expect(
			verifyRevisionToken(shaped({ sectionFingerprint: 42 })),
		).toBeNull();
	});

	it("refuses garbage and answers null when no secret is configured", () => {
		expect(verifyRevisionToken("not-a-token")).toBeNull();
		expect(verifyRevisionToken("a.b.c")).toBeNull();
		const token = signRevisionToken(payload);
		vi.stubEnv("BETTER_AUTH_SECRET", "");
		expect(verifyRevisionToken(token)).toBeNull();
	});

	it("carries ids, a version and a hash, never anything else", () => {
		const [head] = signRevisionToken(payload).split(".");
		const body = JSON.parse(Buffer.from(head, "base64url").toString());
		expect(Object.keys(body.p).sort()).toEqual(
			[...Object.keys(payload), "purpose"].sort(),
		);
	});
});
