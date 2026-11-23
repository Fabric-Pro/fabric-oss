import { describe, expect, it } from "vitest";
import {
	hasParlumeExternalInvitees,
	isParlumeExternalParticipant,
	PARLUME_MAX_INVITEE_EMAILS,
	parlumeInternalInviteeEmails,
	parlumeSpeakerMark,
} from "../parlume-guests";

describe("isParlumeExternalParticipant", () => {
	it("counts someone who joined without signing in as a guest", () => {
		expect(
			isParlumeExternalParticipant({
				id: "8:teamsvisitor:0123abcd",
				name: "Visitor",
			}),
		).toBe(true);
	});

	it.each(["Pat Example (Guest)", "Pat Example (External)"])(
		"counts %s, labelled by Teams, as a guest",
		(name) => {
			expect(
				isParlumeExternalParticipant({ id: "8:orgid:0123", name }),
			).toBe(true);
		},
	);

	it("does not count a signed-in member of the organization", () => {
		expect(
			isParlumeExternalParticipant({
				id: "8:orgid:0123",
				name: "Dev One",
			}),
		).toBe(false);
	});

	it("counts a visitor labelled by Teams who calls themselves Fabric Parlume as a guest", () => {
		expect(
			isParlumeExternalParticipant({
				id: "8:teamsvisitor:x",
				name: "Fabric Parlume (Unverified)",
			}),
		).toBe(true);
	});

	it.each(["8:teamsvisitor:x", "8:anonymous:x"])(
		"counts a participant named Fabric Parlume with the anonymous id %s as a guest",
		(id) => {
			expect(
				isParlumeExternalParticipant({ id, name: "Fabric Parlume" }),
			).toBe(true);
		},
	);
});

describe("hasParlumeExternalInvitees", () => {
	it("finds an invitee outside the enabler's email domain", () => {
		expect(
			hasParlumeExternalInvitees({
				inviteeDomains: ["example.com", "partner.example"],
				enablerEmail: "dev.one@example.com",
			}),
		).toBe(true);
		expect(
			hasParlumeExternalInvitees({
				inviteeDomains: ["EXAMPLE.com"],
				enablerEmail: "dev.one@example.com",
			}),
		).toBe(false);
	});

	it("treats every invitee as external when the enabler has no domain to compare with", () => {
		expect(
			hasParlumeExternalInvitees({
				inviteeDomains: ["example.com"],
				enablerEmail: null,
			}),
		).toBe(true);
		expect(
			hasParlumeExternalInvitees({
				inviteeDomains: [],
				enablerEmail: null,
			}),
		).toBe(false);
	});
});

describe("parlumeInternalInviteeEmails", () => {
	it("keeps the addresses from the enabler's domain, lower-cased and once each, and no one else's", () => {
		expect(
			parlumeInternalInviteeEmails({
				inviteeEmails: [
					" Dev.Two@Example.com ",
					"dev.two@example.com",
					"pat@partner.example",
					"dev.three@sub.example.com",
					"@example.com",
				],
				enablerEmail: "Dev.One@example.com",
			}),
		).toEqual(["dev.two@example.com"]);
	});

	it("keeps none when the enabler has no domain to compare with", () => {
		expect(
			parlumeInternalInviteeEmails({
				inviteeEmails: ["dev.two@example.com"],
				enablerEmail: null,
			}),
		).toEqual([]);
	});

	it("keeps at most 200 addresses", () => {
		const many = Array.from({ length: 250 }, (_, i) => `d${i}@example.com`);

		expect(
			parlumeInternalInviteeEmails({
				inviteeEmails: many,
				enablerEmail: "dev.one@example.com",
			}),
		).toHaveLength(PARLUME_MAX_INVITEE_EMAILS);
	});
});

describe("parlumeSpeakerMark", () => {
	// As Fabric recorded the participants it checked when they joined.
	const marks = {
		memberSpeakerIds: ["8:orgid:00000000-0000-4000-8000-000000000001"],
		guestSpeakerIds: ["8:orgid:00000000-0000-4000-8000-000000000002"],
	};

	it("marks a participant Fabric confirmed by their Teams sign-in a member", () => {
		expect(
			parlumeSpeakerMark(
				{
					id: "8:orgid:00000000-0000-4000-8000-000000000001",
					name: "Dev One",
				},
				marks,
			),
		).toBe("member");
	});

	it("marks the confirmed asker of a request a member, without a speaker id", () => {
		expect(
			parlumeSpeakerMark(
				{ id: null, name: null, userId: "user-1" },
				marks,
			),
		).toBe("member");
	});

	it.each([
		["joined without signing in", "8:teamsvisitor:guest-1", "Visitor"],
		["joined anonymously", "8:anonymous:guest-2", "Visitor"],
		[
			"was labelled a guest by Teams",
			"8:orgid:00000000-0000-4000-8000-000000000003",
			"Pat Example (Guest)",
		],
		[
			"signed in but could not be confirmed",
			"8:orgid:00000000-0000-4000-8000-000000000002",
			"Pat Example",
		],
	])("marks someone who %s a guest", (_label, id, name) => {
		expect(parlumeSpeakerMark({ id, name }, marks)).toBe("guest");
	});

	it("keeps a guest a guest, whatever account a request names", () => {
		expect(
			parlumeSpeakerMark(
				{
					id: "8:teamsvisitor:guest-1",
					name: "Visitor",
					userId: "user-1",
				},
				marks,
			),
		).toBe("guest");
	});

	it.each([
		["Teams has not labelled the line yet", null, null],
		["Teams has not named the speaker", null, "Sam"],
		[
			"Fabric has not checked them",
			"8:orgid:00000000-0000-4000-8000-000000000004",
			"Sam",
		],
	])("marks a speaker unknown when %s", (_label, id, name) => {
		expect(parlumeSpeakerMark({ id, name }, marks)).toBe("unknown");
	});
});
