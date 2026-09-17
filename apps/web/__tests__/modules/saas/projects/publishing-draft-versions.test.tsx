/**
 * DraftVersions — the version list a Publishing Suite panel hangs off its
 * "N versions" button (Fizzy #1851).
 *
 * Tested directly rather than only through a panel. The five panels that use
 * it pass different `onAdopt` (BlogPost, CaseStudy and StakeholderEmail do;
 * ShortPost and LinkedInPost deliberately do not, because a short-form run
 * produces OPTIONS and picking one is the panel's own affordance). Both of
 * those shapes have a "where is Restore?" answer to give, and reaching the
 * second one through a panel means standing up that panel's whole fixture to
 * assert something the panel has no part in.
 *
 * Two things are pinned here that a reader complained about and that nothing
 * else would catch:
 *
 *   1. The list is a GRID. One version per full-width row made a long history
 *      read as a page that had gone wrong — the reaction was "why is this so
 *      long", which is a bug report, not a reading. jsdom computes no layout,
 *      so the responsive class list is the only thing there is to assert; the
 *      point of asserting it is that the base case stays ONE column, since a
 *      hardcoded three would break phone width.
 *   2. The adopted version SAYS it is the current one. Rendering no Restore
 *      button for it was read as the product having no Restore at all.
 */

import { DraftVersions } from "@saas/projects/components/publishing-suite/DraftVersions";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const VERSIONS = [
	{ id: "d3", version: 3, createdAt: new Date("2026-09-03T10:00:00Z") },
	{ id: "d2", version: 2, createdAt: new Date("2026-09-02T10:00:00Z") },
	{ id: "d1", version: 1, createdAt: new Date("2026-09-01T10:00:00Z") },
];

function renderVersions(
	props: Partial<React.ComponentProps<typeof DraftVersions>> = {},
) {
	return render(
		<DraftVersions
			versions={VERSIONS}
			renderBody={(id) => <div>Body of {id}</div>}
			{...props}
		/>,
	);
}

async function openList(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: /3 versions/i }));
	return screen.getByRole("list");
}

describe("DraftVersions — the list reads as a list", () => {
	it("lays the versions out in columns that degrade to one on a phone", async () => {
		const user = userEvent.setup();
		renderVersions();

		const list = await openList(user);

		expect(list).toHaveClass("grid");
		expect(list).toHaveClass("sm:grid-cols-2");
		expect(list).toHaveClass("lg:grid-cols-3");
		// The base case must stay a single column. A bare `grid-cols-3` would
		// satisfy "three columns" and be unreadable at 375px.
		expect(list).not.toHaveClass("grid-cols-2");
		expect(list).not.toHaveClass("grid-cols-3");
	});

	it("gives the list more width than the single-version reading view", async () => {
		const user = userEvent.setup();
		renderVersions();

		await openList(user);

		// Three cards do not fit the dialog's default 2xl. The version DETAIL
		// dialog is asserted at 2xl in the reading test below, and the two
		// together are the point: wide to survey, narrow to read.
		expect(screen.getByRole("dialog")).toHaveClass("max-w-4xl");
	});

	it("keeps one card per version, newest first", async () => {
		const user = userEvent.setup();
		renderVersions();

		const list = await openList(user);

		const items = within(list).getAllByRole("listitem");
		expect(items).toHaveLength(3);
		expect(items[0]).toHaveTextContent("Version 3");
		expect(items[2]).toHaveTextContent("Version 1");
	});

	it("says nothing at all below two versions", () => {
		// "Version 1 of 1" invites a reader to look for the others.
		renderVersions({ versions: [VERSIONS[0]] });

		expect(screen.queryByRole("button", { name: /versions/i })).toBeNull();
	});
});

describe("DraftVersions — finding Restore", () => {
	it("offers Restore on every version except the one already saved", async () => {
		const user = userEvent.setup();
		renderVersions({ adoptedId: "d2", onAdopt: vi.fn() });

		const list = await openList(user);
		const items = within(list).getAllByRole("listitem");

		expect(
			within(items[0]).queryByRole("button", { name: "Restore" }),
		).toBeInTheDocument();
		expect(
			within(items[2]).queryByRole("button", { name: "Restore" }),
		).toBeInTheDocument();
		expect(
			within(items[1]).queryByRole("button", { name: "Restore" }),
		).toBeNull();
	});

	it("tells the adopted version it is the current one instead of leaving a gap", async () => {
		// The reported symptom was "I don't see a Restore button". An empty
		// slot cannot explain why it is empty.
		const user = userEvent.setup();
		renderVersions({ adoptedId: "d2", onAdopt: vi.fn() });

		const list = await openList(user);
		const adopted = within(list).getAllByRole("listitem")[1];

		expect(adopted).toHaveTextContent(/current version/i);
		expect(adopted).toHaveTextContent(/saved from this/i);
	});

	it("hands Restore the version it sits next to, not the newest", async () => {
		const user = userEvent.setup();
		const onAdopt = vi.fn();
		renderVersions({ adoptedId: "d3", onAdopt });

		const list = await openList(user);
		const oldest = within(list).getAllByRole("listitem")[2];
		await user.click(
			within(oldest).getByRole("button", { name: "Restore" }),
		);

		expect(onAdopt).toHaveBeenCalledWith("d1");
	});

	it("holds Restore still while an adoption is in flight", async () => {
		const user = userEvent.setup();
		renderVersions({ onAdopt: vi.fn(), isAdopting: true });

		const list = await openList(user);

		for (const button of within(list).getAllByRole("button", {
			name: "Restore",
		})) {
			expect(button).toBeDisabled();
		}
	});

	it("points a panel that cannot restore at the version itself", async () => {
		// ShortPost and LinkedInPost pass no `onAdopt` — their runs produce
		// several options, so taking one happens inside the version, not on
		// the card. Saying nothing is what made Restore look absent.
		const user = userEvent.setup();
		renderVersions();

		const list = await openList(user);

		expect(
			within(list).queryByRole("button", { name: "Restore" }),
		).toBeNull();
		expect(screen.getByRole("dialog")).toHaveTextContent(/open a version/i);
	});

	it("promises the other versions survive a restore", async () => {
		// The fear behind the request was that restoring v1 destroys v3. It
		// does not: generated versions are append-only and only the working
		// draft is replaced.
		const user = userEvent.setup();
		renderVersions({ onAdopt: vi.fn() });

		await openList(user);

		expect(screen.getByRole("dialog")).toHaveTextContent(
			/every other version stays/i,
		);
	});
});

describe("DraftVersions — reading one version", () => {
	it("opens that version's own body, in a narrower dialog", async () => {
		const user = userEvent.setup();
		renderVersions({ onAdopt: vi.fn() });

		const list = await openList(user);
		const oldest = within(list).getAllByRole("listitem")[2];
		await user.click(within(oldest).getByRole("button", { name: "View" }));

		const detail = await screen.findByRole("dialog", {
			name: /version 1/i,
		});
		expect(detail).toHaveTextContent("Body of d1");
		// Prose gets worse as the measure gets wider, so this one stays 2xl.
		expect(detail).toHaveClass("max-w-2xl");
	});

	it("names the current version in its own detail view rather than showing only Close", async () => {
		const user = userEvent.setup();
		renderVersions({ adoptedId: "d3", onAdopt: vi.fn() });

		const list = await openList(user);
		const newest = within(list).getAllByRole("listitem")[0];
		await user.click(within(newest).getByRole("button", { name: "View" }));

		const detail = await screen.findByRole("dialog", {
			name: /version 3/i,
		});
		expect(
			within(detail).queryByRole("button", {
				name: /restore this version/i,
			}),
		).toBeNull();
		expect(detail).toHaveTextContent(/your saved draft came from/i);
	});

	it("describes each card's buttons by its version, since three say 'View'", async () => {
		// The visible names stay short for the eye; the context a screen
		// reader needs rides on `aria-describedby` so the accessible NAME is
		// still the word on the button.
		const user = userEvent.setup();
		renderVersions({ onAdopt: vi.fn() });

		const list = await openList(user);
		const oldest = within(list).getAllByRole("listitem")[2];
		const describedBy = within(oldest)
			.getByRole("button", { name: "View" })
			.getAttribute("aria-describedby");

		expect(describedBy).toBeTruthy();
		expect(
			document.getElementById(describedBy as string),
		).toHaveTextContent("Version 1");
	});
});

/**
 * A refine writes an ordinary `PublishingTopicDraft` row — same
 * `startTopicDraftAttempt`, same version number, same place in `versions[]`.
 * But it is the SAVED DRAFT with the changes that were asked for, and those
 * changes are accepted one at a time in the refined-draft review. An adopt
 * control on that row takes every change at once, including the ones the
 * reader was on their way to rejecting.
 *
 * The discriminator is the STORED row, read through the review's own
 * `readCandidateRefinement` rather than derived a second time here — two
 * readers of one flag is how they drift.
 */
describe("DraftVersions — a refinement is not adoptable from the list", () => {
	const REFINEMENT = {
		generation: {
			refinedFromWorkingDraft: true,
			guidance: "Make it shorter.",
		},
	};
	/** The flag present and false — a refine that was not one. */
	const ORDINARY = {
		generation: { refinedFromWorkingDraft: false, guidance: null },
	};

	const MIXED = [
		{ id: "d3", version: 3, createdAt: new Date(), content: REFINEMENT },
		{ id: "d2", version: 2, createdAt: new Date(), content: ORDINARY },
		// No `content` key at all: a row written before `generation` existed.
		{ id: "d1", version: 1, createdAt: new Date() },
	];

	it("withholds Restore on the refinement and says what the row is", async () => {
		const user = userEvent.setup();
		renderVersions({ versions: MIXED, onAdopt: vi.fn() });

		const list = await openList(user);
		const refined = within(list).getAllByRole("listitem")[0];

		expect(
			within(refined).queryByRole("button", { name: "Restore" }),
		).toBeNull();
		expect(refined).toHaveTextContent(/refined draft/i);
		// Named as the mechanism, not as a place: this list cannot verify the
		// review is on screen, so "review it above" would sometimes be a lie.
		expect(refined).toHaveTextContent(/change by change/i);
	});

	it("still offers Restore on an ordinary candidate beside it", async () => {
		const user = userEvent.setup();
		renderVersions({ versions: MIXED, onAdopt: vi.fn() });

		const list = await openList(user);
		const ordinary = within(list).getAllByRole("listitem")[1];

		expect(
			within(ordinary).queryByRole("button", { name: "Restore" }),
		).toBeInTheDocument();
		expect(ordinary).not.toHaveTextContent(/refined draft/i);
	});

	it("treats a row with no generation block as an ordinary candidate", async () => {
		// Correct rather than merely safe: such a row predates
		// refinement-as-review, so it genuinely is an ordinary candidate and
		// must keep behaving exactly as it always did.
		const user = userEvent.setup();
		renderVersions({ versions: MIXED, onAdopt: vi.fn() });

		const list = await openList(user);
		const legacy = within(list).getAllByRole("listitem")[2];

		expect(
			within(legacy).queryByRole("button", { name: "Restore" }),
		).toBeInTheDocument();
		expect(legacy).not.toHaveTextContent(/refined draft/i);
	});

	it("withholds the footer's Restore too, which is the same bypass one click in", async () => {
		const user = userEvent.setup();
		renderVersions({ versions: MIXED, onAdopt: vi.fn() });

		const list = await openList(user);
		const refined = within(list).getAllByRole("listitem")[0];
		await user.click(within(refined).getByRole("button", { name: "View" }));

		const detail = await screen.findByRole("dialog", {
			name: /version 3/i,
		});
		expect(
			within(detail).queryByRole("button", {
				name: /restore this version/i,
			}),
		).toBeNull();
		expect(detail).toHaveTextContent(/one change at a time/i);
	});

	it("keeps the footer's Restore for an ordinary candidate", async () => {
		const user = userEvent.setup();
		renderVersions({ versions: MIXED, onAdopt: vi.fn() });

		const list = await openList(user);
		const ordinary = within(list).getAllByRole("listitem")[1];
		await user.click(
			within(ordinary).getByRole("button", { name: "View" }),
		);

		const detail = await screen.findByRole("dialog", {
			name: /version 2/i,
		});
		expect(
			within(detail).queryByRole("button", {
				name: /restore this version/i,
			}),
		).toBeInTheDocument();
	});

	it("says 'current version' rather than 'refined draft' when a row is both", async () => {
		// Neither branch offers adopt, so the only question is which sentence
		// is more use — and "this is the one you are holding" wins.
		const user = userEvent.setup();
		renderVersions({ versions: MIXED, adoptedId: "d3", onAdopt: vi.fn() });

		const list = await openList(user);
		const refined = within(list).getAllByRole("listitem")[0];

		expect(refined).toHaveTextContent(/current version/i);
		expect(refined).not.toHaveTextContent(/refined draft/i);
		expect(
			within(refined).queryByRole("button", { name: "Restore" }),
		).toBeNull();
	});
});
