/**
 * `GlossyVisualCard` (Fizzy #2589, U14; R19, R26–R29, KTD13, KTD15): one
 * visual of the Glossy edition with its review controls.
 *
 * Pinned here: editors get Accept, Regenerate, and Discard with a status
 * badge, and Restore once discarded; viewers get the image alone and nothing
 * for a discarded visual; a render failure is a "could not render" card that
 * still offers Regenerate and Discard; an existing diagram cannot be
 * regenerated; a card's own regenerate holds only its own controls; a build
 * holds Regenerate but not review; the detection reason is plain text; and a
 * stuck build or older pipeline offers Rebuild instead of a wait.
 *
 * `next-intl` echoes keys with their values, so copy is asserted by key.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

vi.mock("next-intl", () => {
	const t = (key: string, values?: Record<string, unknown>) =>
		values && Object.keys(values).length > 0
			? `${key}(${Object.entries(values)
					.map(([name, value]) => `${name}=${String(value)}`)
					.join(", ")})`
			: key;
	t.raw = (key: string) => key;
	return {
		useTranslations: () => t,
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (date: Date) => date.toISOString(),
			number: (value: number) => String(value),
			relativeTime: (date: Date) => date.toISOString(),
		}),
	};
});

import { GlossyVisualCard } from "../GlossyVisualCard";
import {
	comparisonVisual,
	diagramVisual,
	TIMELINE_KEY,
	timelineVisual,
} from "./glossy-fixtures";

const IMAGE = {
	dataUrl: "data:image/png;base64,AAAA",
	width: 320,
	height: 120,
};

function renderCard(
	props: Partial<Parameters<typeof GlossyVisualCard>[0]> = {},
) {
	const handlers = {
		onAccept: vi.fn(),
		onDiscard: vi.fn(),
		onRestore: vi.fn(),
		onRegenerate: vi.fn(),
		onRebuild: vi.fn(),
	};
	const view = render(
		<GlossyVisualCard
			visualKey={TIMELINE_KEY}
			visual={timelineVisual()}
			image={IMAGE}
			decision={null}
			canEdit
			buildRunning={false}
			regenerating={false}
			reviewing={false}
			{...handlers}
			{...props}
		/>,
	);
	return { ...view, handlers };
}

describe("GlossyVisualCard", () => {
	it("shows editors the visual, a pending badge, and Accept, Regenerate, and Discard", async () => {
		const user = userEvent.setup();
		const { handlers } = renderCard();

		const image = screen.getByRole("img");
		expect(image).toHaveAttribute("src", IMAGE.dataUrl);
		// The alt text carries the visual's own labels.
		expect(image.getAttribute("alt")).toContain("Discovery");
		expect(screen.getByText("status.pending")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "accept" }));
		await user.click(screen.getByRole("button", { name: "regenerate" }));
		await user.click(screen.getByRole("button", { name: "discard" }));
		expect(handlers.onAccept).toHaveBeenCalledTimes(1);
		expect(handlers.onRegenerate).toHaveBeenCalledTimes(1);
		expect(handlers.onDiscard).toHaveBeenCalledTimes(1);
		expect(
			screen.queryByRole("button", { name: "restore" }),
		).not.toBeInTheDocument();
	});

	it("reads Accepted once accepted, with Accept no longer offered", () => {
		renderCard({ decision: "ACCEPTED" });

		expect(screen.getByText("status.accepted")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "accept" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "discard" })).toBeEnabled();
	});

	it("collapses a discarded visual to Restore for editors", async () => {
		const user = userEvent.setup();
		const { handlers } = renderCard({ decision: "DISCARDED" });

		expect(screen.queryByRole("img")).not.toBeInTheDocument();
		expect(screen.getByText("status.discarded")).toBeInTheDocument();
		expect(screen.getByText("discardedNote")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "accept" }),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "restore" }));
		expect(handlers.onRestore).toHaveBeenCalledTimes(1);
	});

	it("shows viewers the image alone, and nothing for a discarded visual (AE7, R29)", () => {
		const { container, rerender } = renderCard({ canEdit: false });

		expect(screen.getByRole("img")).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.queryByText("status.pending")).not.toBeInTheDocument();
		// The detection reason is review information, not edition content.
		expect(
			screen.queryByText("The section lists phases with dates."),
		).not.toBeInTheDocument();

		rerender(
			<GlossyVisualCard
				visualKey={TIMELINE_KEY}
				visual={timelineVisual()}
				image={IMAGE}
				decision="DISCARDED"
				canEdit={false}
				buildRunning={false}
				regenerating={false}
				reviewing={false}
				onAccept={vi.fn()}
				onDiscard={vi.fn()}
				onRestore={vi.fn()}
				onRegenerate={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows a render failure as a could-not-render card with Regenerate and Discard", () => {
		renderCard({ image: null });

		expect(screen.queryByRole("img")).not.toBeInTheDocument();
		expect(screen.getByText("couldNotRender")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "regenerate" }),
		).toBeEnabled();
		expect(screen.getByRole("button", { name: "discard" })).toBeEnabled();
		// Approving a visual nobody can see is not offered.
		expect(screen.getByRole("button", { name: "accept" })).toBeDisabled();
	});

	it("shows a placeholder while the visual renders, and offers no Accept until it is seen", () => {
		renderCard({ image: undefined });

		expect(screen.queryByRole("img")).not.toBeInTheDocument();
		expect(screen.getByText("rendering")).toBeInTheDocument();
		// Nobody can approve a visual they have not seen; the render may yet fail.
		expect(screen.getByRole("button", { name: "accept" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "discard" })).toBeEnabled();
	});

	it("holds the notice's Rebuild when a build cannot start from here", async () => {
		const user = userEvent.setup();
		const { handlers } = renderCard({
			notice: { kind: "rebuildRequired" },
			rebuildDisabled: true,
		});

		const rebuild = screen.getByRole("button", { name: "toolbar.rebuild" });
		expect(rebuild).toBeDisabled();
		await user.click(rebuild);
		expect(handlers.onRebuild).not.toHaveBeenCalled();
	});

	it("offers no Regenerate on an existing diagram, or after the server said it cannot", () => {
		const { rerender } = renderCard({
			visualKey: "visual-diagram",
			visual: diagramVisual(),
		});
		expect(screen.getByText("restyled")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "regenerate" }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "discard" })).toBeEnabled();

		rerender(
			<GlossyVisualCard
				visualKey="visual-comparison"
				visual={comparisonVisual()}
				image={IMAGE}
				decision={null}
				canEdit
				buildRunning={false}
				regenerating={false}
				reviewing={false}
				regenerateUnavailable
				notice={{ kind: "notRegenerable" }}
				onAccept={vi.fn()}
				onDiscard={vi.fn()}
				onRestore={vi.fn()}
				onRegenerate={vi.fn()}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: "regenerate" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByText("visual.notices.notRegenerable"),
		).toBeInTheDocument();
	});

	it("holds its own controls, with a progress message, while its regenerate runs", () => {
		renderCard({ regenerating: true });

		for (const name of ["accept", "regenerate", "discard"]) {
			expect(screen.getByRole("button", { name })).toBeDisabled();
		}
		expect(screen.getByRole("status")).toHaveTextContent("regenerating");
	});

	it("holds Regenerate, but not review, while a build runs", () => {
		renderCard({ buildRunning: true });

		expect(
			screen.getByRole("button", { name: "regenerate" }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: "accept" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "discard" })).toBeEnabled();
	});

	it("renders a detection reason containing HTML as text (KTD13)", () => {
		const reason =
			'<b>Bold</b><img src="https://attacker.example.com/x.png">';
		const { container } = renderCard({
			visual: timelineVisual({ reason }),
		});

		expect(screen.getByText(reason)).toBeInTheDocument();
		expect(container.querySelector("b")).toBeNull();
		expect(container.querySelectorAll("img")).toHaveLength(1);
		expect(
			container.querySelector('img[src^="https://attacker"]'),
		).toBeNull();
	});

	it("offers Rebuild instead of a wait when a stuck build holds the edition", async () => {
		const user = userEvent.setup();
		const { handlers } = renderCard({
			notice: {
				kind: "building",
				startedBy: "Dana Example",
				stuck: true,
			},
		});

		const notice = screen.getByText("visual.notices.buildingStuck");
		await user.click(
			within(notice.closest("[role=status]") as HTMLElement).getByRole(
				"button",
				{ name: "toolbar.rebuild" },
			),
		);
		expect(handlers.onRebuild).toHaveBeenCalledTimes(1);
	});

	it("names who holds a live build and offers no Rebuild then", () => {
		renderCard({
			notice: {
				kind: "building",
				startedBy: "Dana Example",
				stuck: false,
			},
		});

		expect(
			screen.getByText("visual.notices.buildingBy(name=Dana Example)"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "toolbar.rebuild" }),
		).not.toBeInTheDocument();
	});

	it("says why no valid replacement was found, in translated copy", () => {
		renderCard({
			notice: { kind: "noValidReplacement", reason: "fact_check" },
		});

		expect(
			screen.getByText(
				"visual.notices.noValidReplacement(reason=report.dropReasons.fact_check)",
			),
		).toBeInTheDocument();
	});

	it("maps an unknown reason code to generic copy", () => {
		renderCard({
			notice: { kind: "noValidReplacement", reason: "something_new" },
		});

		expect(
			screen.getByText(
				"visual.notices.noValidReplacement(reason=report.dropReasons.unknown)",
			),
		).toBeInTheDocument();
	});

	it("has no axe violations for an editor, a viewer, and a failed render", async () => {
		const editor = renderCard();
		expect(await axe(editor.container)).toHaveNoViolations();
		editor.unmount();

		const viewer = renderCard({ canEdit: false });
		expect(await axe(viewer.container)).toHaveNoViolations();
		viewer.unmount();

		const failed = renderCard({ image: null, decision: "ACCEPTED" });
		expect(await axe(failed.container)).toHaveNoViolations();
	});
});
