/**
 * The published version as labelled facts: what each one says for an upload
 * and for a synced repository, which of them only appear when there is
 * something to say, and the three that lead somewhere (Show the left-out
 * files, See what changed, Connect your agent).
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

import type { InstructionsSnapshot } from "../../../lib/instructions-snapshot";
import { InstructionsStatusStrip } from "../InstructionsStatusStrip";

const UPLOAD: InstructionsSnapshot = {
	id: "s7",
	version: 7,
	status: "READY",
	source: "UPLOAD",
	fileCount: 17,
	excludedCount: 4,
	excludedPaths: [
		{ path: "tasks/a.md", rule: "tasks/" },
		{ path: "tasks/b.md", rule: "tasks/" },
		{ path: "tasks/c.md", rule: "tasks/" },
		{ path: "retro.md", rule: "retro.md" },
	],
	createdAt: new Date(),
	user: { id: "u", name: "Dana Whitfield" },
};

const REPOSITORY: InstructionsSnapshot = {
	...UPLOAD,
	source: "REPOSITORY",
	sourceRef: "main",
	sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
};

function renderStrip(
	props: Partial<React.ComponentProps<typeof InstructionsStatusStrip>> = {},
) {
	const handlers = {
		onToggleLeftOut: vi.fn(),
		onCompare: vi.fn(),
		onConnect: vi.fn(),
	};
	render(
		<InstructionsStatusStrip
			published={UPLOAD}
			repository="example-org/instructions"
			reason="by the rules in .fabricignore"
			publishedBy={<span>Dana Whitfield · 3d ago</span>}
			leftOutShown={false}
			{...handlers}
			{...props}
		/>,
	);
	return {
		...handlers,
		strip: screen.getByTestId("instructions-status-strip"),
	};
}

/** The value a labelled fact holds, as `label` + `value` text. */
function fact(strip: HTMLElement, label: string) {
	return within(strip).getByText(label).parentElement as HTMLElement;
}

describe("InstructionsStatusStrip", () => {
	it("states an upload as labelled facts, each with its own label", () => {
		const { strip } = renderStrip();

		expect(fact(strip, "Source")).toHaveTextContent("SourceFolder upload");
		expect(fact(strip, "Published")).toHaveTextContent(
			"PublishedDana Whitfield · 3d ago",
		);
		expect(fact(strip, "Stored")).toHaveTextContent("Stored17 files");
		expect(fact(strip, "Left out")).toHaveTextContent(
			"Left out4 files by the rules in .fabricignore",
		);
		expect(fact(strip, "Agents read it through")).toHaveTextContent(
			"Agents read it throughFabric MCP",
		);
		expect(
			within(strip).queryByText(/Since version/),
		).not.toBeInTheDocument();
	});

	it("labels with the app's sentence-case label class, not capitals", () => {
		const { strip } = renderStrip();

		const label = within(strip).getByText("Stored");

		expect(label.tagName).toBe("DT");
		expect(label).toHaveClass("fab-label");
		expect(label.className).not.toMatch(/uppercase/);
	});

	it("names a synced version by repository and branch, and its author by the commit", () => {
		const { strip } = renderStrip({
			published: REPOSITORY,
			publishedBy: <span>Jane Doe · 2h ago · “Tighten lint rules”</span>,
		});

		expect(fact(strip, "Source")).toHaveTextContent(
			"Sourceexample-org/instructions @ main",
		);
		expect(fact(strip, "Published")).toHaveTextContent(
			"PublishedJane Doe · 2h ago · “Tighten lint rules”",
		);
		expect(fact(strip, "Stored")).toHaveTextContent("Stored17 files");
	});

	it("says an edit was edited from its base, not uploaded from a folder", () => {
		const { strip } = renderStrip({
			published: { ...UPLOAD, baseVersion: 6, baseSnapshotId: "s6" },
		});

		expect(fact(strip, "Source")).toHaveTextContent(
			"SourceEdited from version 6",
		);
	});

	it("leaves the Left out fact out when nothing was left out", () => {
		const { strip } = renderStrip({
			published: { ...UPLOAD, excludedCount: 0, excludedPaths: [] },
		});

		expect(within(strip).queryByText("Left out")).not.toBeInTheDocument();
	});

	describe("Show and Hide", () => {
		it("offers Show while the files are hidden and Hide while they are shown", async () => {
			const user = userEvent.setup();
			const view = renderStrip();

			await user.click(
				within(view.strip).getByRole("button", { name: "Show" }),
			);

			expect(view.onToggleLeftOut).toHaveBeenCalledTimes(1);
		});

		it("says Hide once they are shown", () => {
			const { strip } = renderStrip({ leftOutShown: true });

			expect(
				within(strip).getByRole("button", { name: "Hide" }),
			).toHaveAttribute("aria-pressed", "true");
		});

		it("offers neither for a version that stored no names beside a non-zero count", () => {
			const { strip } = renderStrip({
				published: { ...UPLOAD, excludedPaths: [] },
			});

			expect(strip).toHaveTextContent("Left out4 files");
			expect(
				within(strip).queryByRole("button", { name: /Show|Hide/ }),
			).not.toBeInTheDocument();
		});

		it("offers neither for a version made before the names were kept at all", () => {
			const { excludedPaths: _names, ...before } = UPLOAD;
			const { strip } = renderStrip({ published: before });

			expect(
				within(strip).queryByRole("button", { name: /Show|Hide/ }),
			).not.toBeInTheDocument();
		});

		it("says nothing of a cap until the files are shown", () => {
			const { strip } = renderStrip({
				published: { ...UPLOAD, excludedCount: 4000 },
			});

			expect(strip).not.toHaveTextContent("Showing the first");
		});

		it("says it shows only the first names when the version kept fewer than it left out", () => {
			const { strip } = renderStrip({
				published: { ...UPLOAD, excludedCount: 4000 },
				leftOutShown: true,
			});

			expect(strip).toHaveTextContent(
				"Showing the first 4 of 4,000 files.",
			);
			expect(strip).toHaveTextContent("4,000 files");
		});
	});

	describe("Since version", () => {
		const comparison = (over: Record<string, unknown> = {}) => ({
			from: { version: 6 },
			added: [{ path: "a.md" }],
			removed: [],
			changed: [{ path: "b.md" }, { path: "c.md" }],
			...over,
		});

		it("counts what was added, changed and removed since the base, and opens the comparison", async () => {
			const user = userEvent.setup();
			const view = renderStrip({
				comparison: comparison({ removed: [{ path: "d.md" }] }),
			});

			const since = fact(view.strip, "Since version 6");
			expect(since).toHaveTextContent("1 added · 2 changed · 1 removed");
			expect(within(since).getByText("1 added")).toHaveClass(
				"text-success",
			);
			expect(within(since).getByText("2 changed")).toHaveClass(
				"text-highlight-ink",
			);
			expect(within(since).getByText("1 removed")).toHaveClass(
				"text-destructive",
			);

			await user.click(
				within(since).getByRole("button", { name: "See what changed" }),
			);
			expect(view.onCompare).toHaveBeenCalledTimes(1);
		});

		it("says there were no changes plainly, with nothing to open", () => {
			const { strip } = renderStrip({
				comparison: comparison({ added: [], changed: [] }),
			});

			expect(fact(strip, "Since version 6")).toHaveTextContent(
				"Since version 6No file changes",
			);
			expect(
				within(strip).queryByRole("button", {
					name: "See what changed",
				}),
			).not.toBeInTheDocument();
		});

		it("is not there at all without a comparison", () => {
			const { strip } = renderStrip({ comparison: undefined });

			expect(strip).not.toHaveTextContent("Since version");
		});
	});

	describe("Connect your agent", () => {
		it("sits beside Fabric MCP, carries the page tour's anchor, and opens the Connect dialog", async () => {
			const user = userEvent.setup();
			const view = renderStrip();

			const connect = within(
				fact(view.strip, "Agents read it through"),
			).getByRole("button", { name: "Connect your agent" });
			expect(connect).toHaveAttribute(
				"data-onboarding-target",
				"coding-instructions-connect",
			);
			await user.click(connect);

			expect(view.onConnect).toHaveBeenCalledTimes(1);
		});

		it("is not offered, and leaves no anchor behind, when the viewer cannot connect an agent", () => {
			const { strip } = renderStrip({ onConnect: undefined });

			expect(fact(strip, "Agents read it through")).toHaveTextContent(
				"Fabric MCP",
			);
			expect(
				within(strip).queryByRole("button", {
					name: "Connect your agent",
				}),
			).not.toBeInTheDocument();
			expect(
				strip.querySelector(
					'[data-onboarding-target="coding-instructions-connect"]',
				),
			).toBeNull();
		});

		it("carries its own tour anchor on the strip, with none on a hidden element", () => {
			const { strip } = renderStrip();

			expect(strip).toHaveAttribute(
				"data-onboarding-target",
				"coding-instructions-status",
			);
			for (const anchor of document.querySelectorAll(
				"[data-onboarding-target]",
			)) {
				expect(anchor.closest('[aria-hidden="true"]')).toBeNull();
			}
		});
	});
});
