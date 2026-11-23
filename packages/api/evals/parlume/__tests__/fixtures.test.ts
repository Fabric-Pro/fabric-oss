/**
 * The bundled synthetic meetings: they parse, their ground truth points at
 * segments that exist, they cover the cases the evaluation is for, they hold
 * only placeholder identities, and the long one runs the checkpoint path.
 */
import { writeAnchoredNotes } from "@repo/temporal/parlume-notes-passes";
import { PARLUME_BOT_NAME } from "@repo/utils/parlume-notes";
import { describe, expect, it, vi } from "vitest";
import {
	buildEvalTranscript,
	DEFAULT_FIXTURES_DIR,
	evalSegments,
	loadEvalFixtures,
	type ParlumeEvalFixture,
} from "../fixture";

vi.mock("@repo/ai", () => ({
	generateText: vi.fn(),
	Output: { object: (spec: unknown) => spec },
}));

const fixtures = await loadEvalFixtures([DEFAULT_FIXTURES_DIR]);

/** A host name in a line, with or without a scheme. */
const HOST = /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})/gi;
const PLACEHOLDER_HOST = /(?:^|\.)example\.com$/;

function byId(id: string): ParlumeEvalFixture {
	const fixture = fixtures.find((candidate) => candidate.id === id);
	if (!fixture) {
		throw new Error(`no fixture ${id}`);
	}
	return fixture;
}

describe("Parlume eval fixtures", () => {
	it("bundles eight to twelve meetings with distinct ids", () => {
		const ids = fixtures.map((fixture) => fixture.id);
		expect(ids.length).toBeGreaterThanOrEqual(8);
		expect(ids.length).toBeLessThanOrEqual(12);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("covers the cases the evaluation is for", () => {
		const covers = fixtures.flatMap((fixture) => fixture.covers).join("\n");
		for (const needed of [
			"short meeting",
			"three-hour meeting",
			"inverted-meaning",
			"speech-to-text noise",
			"side talk",
			"guest",
			"no decisions",
			"Parlume's own chat post",
		]) {
			expect(covers, needed).toContain(needed);
		}
	});

	it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))(
		"%s names only segments it has, in spoken order",
		(_id, fixture) => {
			const ids = fixture.segments.map((segment) => segment.id);
			expect(new Set(ids).size).toBe(ids.length);
			const named = [
				...fixture.truth.decisions.flatMap((item) => item.segments),
				...fixture.truth.actionItems.flatMap((item) => item.segments),
				...fixture.suggestions.passesAfter,
				...fixture.filler.map((filler) => filler.afterSegment),
			];
			for (const id of named) {
				expect(ids).toContain(id);
			}
			const starts = fixture.segments.map((segment) => segment.startMs);
			expect(starts).toEqual([...starts].sort((a, b) => a - b));
			for (const segment of fixture.segments) {
				expect(segment.endMs).toBeGreaterThanOrEqual(segment.startMs);
			}
		},
	);

	it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))(
		"%s holds only placeholder people and hosts",
		(_id, fixture) => {
			const segments = evalSegments(fixture);
			for (const segment of segments) {
				if (segment.speaker && segment.speaker !== PARLUME_BOT_NAME) {
					expect(segment.speaker).toMatch(/ Example$/);
				}
				for (const match of segment.text.matchAll(HOST)) {
					expect(match[1]?.toLowerCase()).toMatch(PLACEHOLDER_HOST);
				}
			}
			const owners = fixture.truth.actionItems.flatMap((item) =>
				item.owner ? [item.owner] : [],
			);
			for (const owner of owners) {
				expect(owner).toMatch(/ Example$/);
			}
		},
	);

	it("runs the three-hour meeting as checkpoint parts", async () => {
		const fixture = byId("long-roadmap-3h");
		const segments = evalSegments(fixture);
		const last = segments.at(-1);
		expect(last?.endMs ?? 0).toBeGreaterThanOrEqual(3 * 60 * 60 * 1000);

		const prompts: string[] = [];
		const { parts } = await writeAnchoredNotes({
			content: buildEvalTranscript(fixture).content,
			chatDeliveryFacts: "",
			pass: async (prompt) => {
				prompts.push(prompt);
				return {};
			},
		});
		expect(parts).toBeGreaterThan(1);
		expect(prompts).toHaveLength(parts);
	});

	it("writes the transcript as finalization does: guest, chat and markers", () => {
		const guest = buildEvalTranscript(byId("guest-line")).content;
		expect(guest).toContain(
			"Pat Example (unverified speaker): Yes, signed webhooks.",
		);
		expect(guest.split("\n")[0]).toBe("Captured incoming speech:");

		const chat = buildEvalTranscript(byId("chat-and-markers"));
		expect(chat.content).toContain("[chat] Morgan Example: Comparison:");
		expect(chat.content).toContain(
			"[Parlume] Listening paused by Lee Example.",
		);
		// Line 1 is the header; segment 1 is on line 2.
		expect(chat.segmentAtLine.get(2)).toBe(1);
	});

	it("writes Parlume's post on its lines, none of them shown to the notes, and a person's chat message of several lines in full", async () => {
		const transcript = buildEvalTranscript(byId("parlume-chat-post"));
		const lines = transcript.content.split("\n");
		const postLines = [...transcript.segmentAtLine]
			.filter(([, segment]) => segment === 3)
			.map(([line]) => line);
		expect(postLines).toHaveLength(7);
		expect(lines[(postLines[0] ?? 0) - 1]).toBe(
			"[chat] Fabric Parlume: [P2] Detail for Robin Example\r",
		);
		const chatLines = [...transcript.segmentAtLine]
			.filter(([, segment]) => segment === 6)
			.map(([line]) => line);
		expect(chatLines).toHaveLength(3);

		const prompts: string[] = [];
		await writeAnchoredNotes({
			content: transcript.content,
			chatDeliveryFacts: "",
			pass: async (prompt) => {
				prompts.push(prompt);
				return {};
			},
		});
		const [prompt = ""] = prompts;
		for (const line of postLines) {
			expect(prompt).not.toContain(`[${line}] `);
		}
		expect(prompt).not.toContain("move the beta launch to May");
		for (const line of chatLines) {
			expect(prompt).toContain(`[${line}] `);
		}
		expect(prompt).toContain("remove the old trial banner");
	});

	it("marks generated filler lines as no fixture segment", () => {
		const { segmentAtLine } = buildEvalTranscript(byId("long-roadmap-3h"));
		const values = [...segmentAtLine.values()];
		expect(values.filter((id) => id === null).length).toBe(900);
		expect(values.filter((id) => id !== null).length).toBe(16);
	});
});
