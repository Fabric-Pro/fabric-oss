/**
 * The commit text of a Living Memory write (ADR-022): the attribution every
 * Fabric commit has, the same refusals as a direct commit, and the trailers
 * that are Fabric's own. Assembled at run time: no address- or token-shaped
 * literal in the tree.
 */
import { describe, expect, it } from "vitest";
import {
	agentTrailerValue,
	hasReservedTrailerLine,
	normaliseCommitMessage,
	renderDirectCommitText,
	renderMemoryWriteText,
} from "../src/pull-request-text";

const NOREPLY = ["noreply", "example.com"].join("@");
const MAIL_FROM = `Fabric <${NOREPLY}>`;
const TOKEN = `${"gh"}${"p_"}${"A".repeat(36)}`;
const WRITE_ID = "cmemwrite00000001";

function render(
	overrides: Partial<Parameters<typeof renderMemoryWriteText>[0]> = {},
) {
	return renderMemoryWriteText({
		message: "Add notes\n\nAn agent's notes.",
		proposerName: "Pat Example",
		mailFrom: MAIL_FROM,
		writeId: WRITE_ID,
		agentId: "client_example-1",
		...overrides,
	});
}

describe("renderMemoryWriteText", () => {
	it("attributes the commit to the member and commits it as Fabric, both on the deployment's noreply address", () => {
		const text = render();

		expect(text).toMatchObject({
			ok: true,
			author: { name: "Pat Example", email: NOREPLY },
			committer: { name: "Fabric", email: NOREPLY },
			subject: "Add notes",
			body: "An agent's notes.",
			message: "Add notes\n\nAn agent's notes.",
		});
	});

	it("ends the commit message with the write's trailer and the agent's, in a paragraph of their own", () => {
		const text = render();

		expect(text.ok && text.commitMessage).toBe(
			[
				"Add notes",
				"",
				"An agent's notes.",
				"",
				`Fabric-Memory-Write: ${WRITE_ID}`,
				"Fabric-Agent: client_example-1",
				"",
			].join("\n"),
		);
	});

	it("leaves the agent trailer out when no OAuth client is known, or none of its characters are safe", () => {
		for (const agentId of [undefined, null, "", "///"]) {
			const text = render({ agentId });
			expect(text.ok && text.commitMessage).toBe(
				`Add notes\n\nAn agent's notes.\n\nFabric-Memory-Write: ${WRITE_ID}\n`,
			);
		}
	});

	it("keeps only the safe characters of the agent id, at most sixty-four", () => {
		expect(agentTrailerValue("client id/with:odd\nchars_1.0-x")).toBe(
			"clientidwithoddchars_1.0-x",
		);
		expect(agentTrailerValue("a".repeat(100))).toHaveLength(64);
		expect(agentTrailerValue(undefined)).toBe("");
	});

	it.each([
		["Fabric-Commit", "notes\n\nFabric-Commit: cabc12345678"],
		["Fabric-Memory-Write", `notes\n\nFabric-Memory-Write: ${WRITE_ID}`],
		["Fabric-Agent", "notes\n\nFabric-Agent: client_1"],
		["a trailer in any case", "notes\n\nFABRIC-MEMORY-WRITE: x"],
		["a trailer with space before the colon", "notes\n\nFabric-Agent : x"],
		[
			"a trailer behind a control character",
			"notes\n\nFabric-Mem\u0001ory-Write: x",
		],
	])("refuses a message with a line that spells %s", (_name, message) => {
		expect(render({ message })).toEqual({
			ok: false,
			code: "MESSAGE_REJECTED",
		});
	});

	it("refuses what a direct commit refuses: empty, over-long, a credential, an unusable address", () => {
		expect(render({ message: "  \n " })).toEqual({
			ok: false,
			code: "MESSAGE_EMPTY",
		});
		expect(render({ message: "m".repeat(5001) })).toEqual({
			ok: false,
			code: "MESSAGE_TOO_LONG",
		});
		expect(render({ message: `rotate ${TOKEN}` })).toEqual({
			ok: false,
			code: "MESSAGE_REJECTED",
		});
		expect(render({ mailFrom: "not an address" })).toEqual({
			ok: false,
			code: "ATTRIBUTION_REJECTED",
		});
	});

	it("falls back to the fixed name for a display name shaped like an address", () => {
		const text = render({ proposerName: ["pat", "example.com"].join("@") });

		expect(text.ok && text.author.name).toBe("a Fabric user");
	});

	it("renders everything but the trailers as a direct commit does", () => {
		const direct = renderDirectCommitText({
			message: "  Add notes \r\n\r\n\r\n\r\nAn agent's notes.  ",
			proposerName: "Pat Example",
			mailFrom: MAIL_FROM,
		});
		const memory = render({
			message: "  Add notes \r\n\r\n\r\n\r\nAn agent's notes.  ",
		});

		expect(direct.ok && memory.ok && memory.message).toBe(
			direct.ok && direct.message,
		);
	});

	it("refuses a write id that is not an id this codebase issues", () => {
		expect(() => render({ writeId: "x\nFabric-Agent: forged" })).toThrow();
	});
});

describe("hasReservedTrailerLine", () => {
	it("sees a trailer on any line and ignores one mentioned in a sentence", () => {
		expect(hasReservedTrailerLine("a\nb\nFabric-Agent: x")).toBe(true);
		expect(hasReservedTrailerLine("Explain the Fabric-Agent: line")).toBe(
			false,
		);
		expect(hasReservedTrailerLine("nothing here")).toBe(false);
	});
});

describe("normaliseCommitMessage", () => {
	it("is the form every check judges: line endings, controls, trailing space and blank runs", () => {
		expect(normaliseCommitMessage("a \r\nb\u0001\n\n\n\nc  \n")).toBe(
			"a\nb\n\nc",
		);
	});
});
