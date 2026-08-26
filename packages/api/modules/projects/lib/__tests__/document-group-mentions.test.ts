import { describe, expect, it } from "vitest";
import {
	diffGroupMentions,
	extractDocumentGroupMentions,
} from "../document-mentions";

const groupSpan = (tag: string, anchor: string) =>
	`<span data-type="mention" data-group-tag="${tag}" data-mention-id="${anchor}" class="mention mention-group">@Group</span>`;
const userSpan = (id: string, anchor: string) =>
	`<span data-type="mention" data-id="${id}" data-mention-id="${anchor}">@U</span>`;

describe("extractDocumentGroupMentions", () => {
	it("pulls group spans and ignores user spans", () => {
		const html = `${userSpan("u1", "m_a")} ${groupSpan("DEVELOPER", "m_b")}`;
		expect(extractDocumentGroupMentions(html)).toEqual([
			{ tag: "DEVELOPER", anchorId: "m_b" },
		]);
	});
	it("skips unknown tags and missing anchors", () => {
		expect(extractDocumentGroupMentions(groupSpan("BOGUS", "m_x"))).toEqual(
			[],
		);
	});
	it("rejects a crafted span carrying BOTH data-id and data-group-tag", () => {
		const mixed = `<span data-type="mention" data-id="alice" data-group-tag="DEVELOPER" data-mention-id="m_z">@x</span>`;
		expect(extractDocumentGroupMentions(mixed)).toEqual([]);
	});
});

describe("diffGroupMentions", () => {
	it("returns only groups whose tag is new in next", () => {
		const prev = [{ tag: "DEVELOPER" as const, anchorId: "m_a" }];
		const next = [
			{ tag: "DEVELOPER" as const, anchorId: "m_a" },
			{ tag: "ARCHITECT" as const, anchorId: "m_b" },
		];
		expect(diffGroupMentions(prev, next)).toEqual([
			{ tag: "ARCHITECT", anchorId: "m_b" },
		]);
	});
	it("does not re-notify a group already present (no re-ping on re-save)", () => {
		const same = [{ tag: "DEVELOPER" as const, anchorId: "m_a" }];
		expect(diffGroupMentions(same, same)).toEqual([]);
	});
});
