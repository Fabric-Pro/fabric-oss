import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReleaseNotesPanel } from "../ReleaseNotesPanel";

const anchor = {
	occurredAt: new Date("2026-06-05T10:00:00Z"),
	title: "Spring hardening release", // distinct from tagName so queries are unambiguous
	repoFullName: "o/r",
	tagName: "v1.3.6",
	url: "https://github.com/o/r/releases/tag/v1.3.6",
	author: "bot",
	body: "## Notes\n- thing",
};

const glAnchor = {
	occurredAt: new Date("2026-06-09T20:00:00Z"), // newer
	title: "GitLab prod release",
	repoFullName: "owner/gl-repo",
	tagName: "v9.0.0",
	url: "https://gitlab.com/owner/gl-repo/-/releases/v9.0.0",
	author: "alice",
};

const ghAnchor = {
	occurredAt: new Date("2026-06-09T08:00:00Z"), // older
	title: "GitHub prod release",
	repoFullName: "owner/gh-repo",
	tagName: "v1.0.0",
	url: "https://github.com/owner/gh-repo/releases/tag/v1.0.0",
	author: "octocat",
};

describe("ReleaseNotesPanel — prod-release anchor fallback", () => {
	it("renders the latest-release block when the prod bucket is empty", () => {
		render(
			<ReleaseNotesPanel
				github={[]}
				storyChanges={[]}
				latestProdRelease={anchor}
			/>,
		);
		// Title rendered as a link; tag badge rendered separately — both unique now.
		expect(
			screen.getByRole("link", { name: /Spring hardening release/ }),
		).toBeInTheDocument();
		expect(screen.getByText("v1.3.6")).toBeInTheDocument(); // the tag badge
		expect(
			screen.queryByText(/Nothing shipped to prod/i),
		).not.toBeInTheDocument();
	});

	it("renders nothing when prod+staging empty and no anchor", () => {
		const { container } = render(
			<ReleaseNotesPanel github={[]} storyChanges={[]} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("does NOT show the fallback when a PR-derived prod release exists", () => {
		const prodPr = {
			kind: "pr_merged",
			prNumber: 1,
			repoFullName: "o/r",
			url: "u",
			occurredAt: new Date("2026-06-05T00:00:00Z"),
			title: "main -> production",
			baseRef: "production",
		} as never;
		render(
			<ReleaseNotesPanel
				github={[prodPr]}
				storyChanges={[]}
				latestProdRelease={anchor}
			/>,
		);
		expect(screen.getByText(/Released/i)).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /Spring hardening release/ }),
		).not.toBeInTheDocument();
	});

	it("renders one LatestReleaseBlock per repo, newest-first", () => {
		render(
			<ReleaseNotesPanel
				github={[]}
				storyChanges={[]}
				latestProdReleasesByRepo={[glAnchor, ghAnchor]} // glAnchor newer
			/>,
		);
		const repos = screen.getAllByText(/owner\/(gl|gh)-repo/);
		expect(repos.map((n) => n.textContent)).toEqual([
			expect.stringContaining("gl-repo"),
			expect.stringContaining("gh-repo"),
		]);
	});

	it("falls back to the single latestProdRelease when the array is absent", () => {
		render(
			<ReleaseNotesPanel
				github={[]}
				storyChanges={[]}
				latestProdRelease={anchor}
			/>,
		);
		expect(screen.getAllByText(/o\/r/)).toHaveLength(1);
	});

	it("hides the per-repo anchor when PR-derived prod releases exist (gating preserved)", () => {
		const prodPr = {
			kind: "pr_merged",
			prNumber: 1,
			repoFullName: "o/r",
			url: "u",
			occurredAt: new Date("2026-06-05T00:00:00Z"),
			title: "main -> production",
			baseRef: "production",
		} as never;
		render(
			<ReleaseNotesPanel
				github={[prodPr]}
				storyChanges={[]}
				latestProdReleasesByRepo={[glAnchor]}
			/>,
		);
		// PR-derived ProdReleaseBlock shown; per-repo anchor block not rendered.
		expect(screen.getByText(/Released/i)).toBeInTheDocument();
		expect(screen.queryByText(/gl-repo/)).not.toBeInTheDocument();
	});
});

describe("ReleaseNotesPanel — hide/unhide (canEdit gating)", () => {
	const prWithStory = {
		kind: "pr_merged",
		prNumber: 7,
		repoFullName: "o/r",
		url: "u",
		occurredAt: new Date("2026-06-06T00:00:00Z"),
		title: "ABC-12: Add feature",
		baseRef: "main",
	} as never;

	const otherPr = {
		kind: "pr_merged",
		prNumber: 42,
		repoFullName: "o/r",
		url: "u",
		occurredAt: new Date("2026-06-06T00:00:00Z"),
		title: "fix: tidy up logging",
		baseRef: "main",
	} as never;

	it("renders no hide controls when canEdit is unset (default)", () => {
		render(<ReleaseNotesPanel github={[prWithStory]} storyChanges={[]} />);
		expect(
			screen.queryByRole("button", { name: /hide from release notes/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /hide feature/i }),
		).not.toBeInTheDocument();
	});

	it("shows a per-PR hide control when canEdit is true and calls onHide with the PR target", () => {
		const onHide = vi.fn();
		render(
			<ReleaseNotesPanel
				github={[otherPr]}
				storyChanges={[]}
				canEdit={true}
				onHide={onHide}
			/>,
		);
		// PR-only rows live in the collapsed "Other changes" category group —
		// expand it to reach the PrLine hide control.
		fireEvent.click(screen.getByRole("button", { name: /fixes/i }));
		fireEvent.click(
			screen.getByRole("button", { name: "Hide from release notes" }),
		);
		expect(onHide).toHaveBeenCalledWith({
			kind: "pr",
			repoFullName: "o/r",
			prNumber: 42,
		});
	});

	it("shows a per-feature hide control on FeatureRow headers and calls onHide with the story target", () => {
		const onHide = vi.fn();
		render(
			<ReleaseNotesPanel
				github={[prWithStory]}
				storyChanges={[]}
				canEdit={true}
				onHide={onHide}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Hide feature ABC-12 from release notes",
			}),
		);
		expect(onHide).toHaveBeenCalledWith({
			kind: "story",
			storyIdentifier: "ABC-12",
		});
	});

	it("renders the hidden-from-release-notes footer with Unhide when exclusions are present", () => {
		const onUnhide = vi.fn();
		const exclusion = {
			id: "excl-1",
			kind: "pr",
			repoFullName: "o/r",
			prNumber: 99,
			storyIdentifier: null,
			reason: null,
			excludedByUserId: "u1",
			createdAt: new Date("2026-06-01T00:00:00Z"),
		} as never;
		render(
			<ReleaseNotesPanel
				github={[]}
				storyChanges={[]}
				canEdit={true}
				exclusions={[exclusion]}
				onUnhide={onUnhide}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /hidden from release notes/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: /unhide/i }));
		expect(onUnhide).toHaveBeenCalledWith("excl-1");
	});
});
