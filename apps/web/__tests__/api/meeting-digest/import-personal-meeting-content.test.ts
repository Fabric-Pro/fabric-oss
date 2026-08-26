import {
	buildImportedContextMetadata,
	buildImportedTranscriptContent,
	MAX_IMPORT_CHARS,
	speakerNamesFromTranscript,
} from "@repo/api/modules/projects/procedures/meeting-digest/import-personal-meeting-content";
import { describe, expect, it } from "vitest";

/**
 * #2170 — the pure half of the personal-meeting import.
 *
 * The header these helpers build is not cosmetic. `ProjectContextsList` groups
 * meeting rows by `metadata.meetingId`, the analyzer reads the body as a
 * `meetingTranscripts` section, and the context detail page renders it as-is.
 * Any drift from the team ingest path's format (`meeting-transcript-sync.ts`
 * step 5) would give imported meetings a second, subtly different shape — so
 * parity is asserted field by field rather than smoke-tested.
 */

describe("speakerNamesFromTranscript", () => {
	it("collects each speaker once, in first-appearance order", () => {
		const transcript = [
			"Ada: morning",
			"Grace: morning",
			"Ada: shall we start",
		].join("\n");

		expect(speakerNamesFromTranscript(transcript)).toEqual([
			"Ada",
			"Grace",
		]);
	});

	it("does not treat a colon inside the spoken text as a second speaker", () => {
		const transcript = [
			"Ada: the rule is simple: never ship on a Friday",
			"Grace: agreed",
		].join("\n");

		expect(speakerNamesFromTranscript(transcript)).toEqual([
			"Ada",
			"Grace",
		]);
	});

	it("returns nothing for raw VTT content, which carries no speaker prefix", () => {
		const vtt = [
			"WEBVTT",
			"",
			"00:00:01.000 --> 00:00:04.000",
			"we should rebuild the importer",
		].join("\n");

		expect(speakerNamesFromTranscript(vtt)).toEqual([]);
	});

	it("ignores an empty speaker name and a prefix long enough to be prose", () => {
		const transcript = [
			": orphaned line",
			`${"x".repeat(200)}: this is a sentence, not a name`,
			"Ada: real line",
		].join("\n");

		expect(speakerNamesFromTranscript(transcript)).toEqual(["Ada"]);
	});
});

describe("buildImportedTranscriptContent", () => {
	const transcript = "Ada: morning\nGrace: morning";

	it("reproduces the team ingest header, field for field", () => {
		const occurrenceDate = "2026-08-14T09:00:00.000Z";
		const content = buildImportedTranscriptContent({
			meetingSubject: "Weekly sync",
			occurrenceDate,
			transcript,
		});

		// Mirrors meeting-transcript-sync.ts step 5, including its use of
		// toLocaleString() — computed here rather than hardcoded so the test
		// does not depend on the runner's locale or zone.
		//
		// One deliberate difference: a blank line separates the header from the
		// body where the team path writes a `---` rule. See the no-rule note in
		// the implementation — a standalone rule is a setext heading underline
		// to a markdown renderer and a transcript delimiter to the analyzer.
		const expected = [
			"## Meeting Transcript: Weekly sync",
			`**Date:** ${new Date(occurrenceDate).toLocaleString()}`,
			"**Participants:** Ada, Grace",
			"",
		].join("\n");

		expect(content).toBe(`${expected}\n${transcript}`);
	});

	// Regression: QA on staging (18 Aug 2026) found the imported body carrying a
	// standalone `---`, which the context viewer rendered as a giant heading and
	// which collides with the `"\n\n---\n\n"` join `analyze-context.ts` uses to
	// separate one selected meeting from the next.
	it("never emits a line that is only a horizontal rule", () => {
		for (const speakers of [transcript, "No speaker labels here at all."]) {
			const content = buildImportedTranscriptContent({
				meetingSubject: "Weekly sync",
				occurrenceDate: "2026-08-14T09:00:00.000Z",
				transcript: speakers,
			});

			expect(
				content.split("\n").some((line) => line.trim() === "---"),
			).toBe(false);
		}
	});

	it("separates the header from the body with a blank line", () => {
		const content = buildImportedTranscriptContent({
			meetingSubject: "Weekly sync",
			occurrenceDate: "2026-08-14T09:00:00.000Z",
			transcript,
		});

		expect(content).toContain("**Participants:** Ada, Grace\n\n");
	});

	it("writes 'Unknown date' rather than an Invalid Date for a missing occurrence", () => {
		const content = buildImportedTranscriptContent({
			meetingSubject: "Weekly sync",
			occurrenceDate: undefined,
			transcript,
		});

		expect(content).toContain("**Date:** Unknown date");
		expect(content).not.toContain("Invalid Date");
	});

	it("writes 'Unknown date' for an unparseable occurrence", () => {
		const content = buildImportedTranscriptContent({
			meetingSubject: "Weekly sync",
			occurrenceDate: "not-a-date",
			transcript,
		});

		expect(content).toContain("**Date:** Unknown date");
		expect(content).not.toContain("Invalid Date");
	});

	it("omits the participants line when no speaker could be parsed", () => {
		const content = buildImportedTranscriptContent({
			meetingSubject: "Weekly sync",
			occurrenceDate: "2026-08-14T09:00:00.000Z",
			transcript: "WEBVTT\n\nsome captions",
		});

		expect(content).not.toContain("**Participants:**");
	});

	it("keeps the transcript body verbatim — import never truncates", () => {
		const long = `Ada: ${"word ".repeat(50_000)}`;
		const content = buildImportedTranscriptContent({
			meetingSubject: "Weekly sync",
			occurrenceDate: "2026-08-14T09:00:00.000Z",
			transcript: long,
		});

		expect(content.endsWith(long)).toBe(true);
		expect(content).not.toContain("truncated");
	});
});

describe("buildImportedContextMetadata", () => {
	it("records the dedup key, the provenance, and the importer", () => {
		const importedAt = new Date("2026-08-17T10:00:00.000Z");

		const metadata = buildImportedContextMetadata({
			meetingId: "meeting-1",
			transcriptId: "transcript-1",
			joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
			meetingSubject: "Weekly sync",
			occurrenceDate: "2026-08-14T09:00:00.000Z",
			speakerNames: ["Ada", "Grace"],
			importedByUserId: "user-1",
			importedAt,
		});

		expect(metadata).toEqual({
			provider: "microsoft-teams",
			// The marker that separates a deliberately imported personal meeting
			// from one the team sync path pulled in on its own.
			origin: "personal-import",
			meetingId: "meeting-1",
			transcriptId: "transcript-1",
			joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
			meetingSubject: "Weekly sync",
			meetingDate: "2026-08-14T09:00:00.000Z",
			speakerNames: ["Ada", "Grace"],
			// Always false: the import stores the transcript as-is (spec D3), so
			// downstream readers must not mistake it for a summarised row.
			wasSummarized: false,
			importedByUserId: "user-1",
			importedAt: importedAt.toISOString(),
		});
	});
});

describe("MAX_IMPORT_CHARS", () => {
	// The guard exists so an absurd transcript fails loudly instead of being
	// quietly sliced (NFR: no silent truncation). A value small enough to catch
	// real meetings would turn that guard into the truncation it replaces.
	it("sits far above any real meeting", () => {
		expect(MAX_IMPORT_CHARS).toBeGreaterThanOrEqual(1_000_000);
	});
});
