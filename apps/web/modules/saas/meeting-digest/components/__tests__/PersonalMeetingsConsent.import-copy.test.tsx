import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PersonalMeetingsConsent } from "../PersonalMeetingsConsent";

/**
 * #2170 follow-up — the consent copy must stay true once a user can import.
 *
 * Found in staging QA, and it is the same defect #2104 already fixed once in
 * this file: the post-consent line used to say "…and are never stored", which
 * stopped being true when device caching shipped, so it was narrowed to
 * transcripts. Importing breaks the remaining claim from the other side — the
 * transcript genuinely IS stored, and genuinely IS visible to the project.
 *
 * The distinction the copy has to carry is what Fabric does ON ITS OWN versus
 * what the user deliberately does. So these tests pin both directions: with the
 * feature off the absolute promise must survive intact (it is still true, and
 * weakening it would scare people off a feature that does nothing of the kind),
 * and with it on the exception must be stated rather than left for the user to
 * discover after the fact.
 */

const noop = () => {};

function renderConsent(props: Record<string, unknown> = {}) {
	return render(
		<PersonalMeetingsConsent
			consented={false}
			onEnable={noop}
			onDisable={noop}
			{...props}
		/>,
	);
}

describe("PersonalMeetingsConsent — import feature OFF", () => {
	it("keeps the absolute no-storage promise before consent", () => {
		renderConsent();

		const text = screen.getByRole("region", {
			name: "Personal meetings",
		}).textContent;
		expect(text).toMatch(/never stored in Fabric/i);
		expect(text).toMatch(/nothing is saved to our database/i);
		expect(text).not.toMatch(/add|import/i);
	});

	it("keeps the absolute promise after consent", () => {
		renderConsent({ consented: true });

		const text = screen.getByRole("region", {
			name: "Personal meetings",
		}).textContent;
		expect(text).toMatch(/transcripts are never stored/i);
		expect(text).not.toMatch(/unless you add/i);
	});
});

describe("PersonalMeetingsConsent — import feature ON", () => {
	it("names the exception before consent instead of promising nothing is saved", () => {
		renderConsent({ importEnabled: true });

		const text = screen.getByRole("region", {
			name: "Personal meetings",
		}).textContent as string;

		// The blanket claim must be gone: it is the sentence a user would rely
		// on, and it is no longer unconditionally true.
		expect(text).not.toMatch(/nothing is saved to our database/i);
		// …and replaced by something that says who does the storing. Matched on
		// meaning rather than an exact sentence: the two variants word it
		// differently, and pinning prose would make this a spelling test.
		expect(text).toMatch(/add .*to the project yourself/i);
	});

	it("names the exception after consent too", () => {
		renderConsent({ consented: true, importEnabled: true });

		const text = screen.getByRole("region", {
			name: "Personal meetings",
		}).textContent as string;
		expect(text).toMatch(/add .*to the project yourself/i);
	});

	// The point is a qualified promise, not a dropped one. A user who never
	// imports anything must still be told Fabric stores nothing by itself.
	it("still says Fabric does not store them on its own", () => {
		renderConsent({ importEnabled: true });

		const text = screen.getByRole("region", {
			name: "Personal meetings",
		}).textContent as string;
		expect(text).toMatch(/never stores them on its own/i);
		expect(text).toMatch(/no one else on this project/i);
	});
});
