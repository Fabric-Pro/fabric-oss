/**
 * Dialog tests for the PM-link step in DuplicateResolveDialog
 * (spec 2026-06-02-merge-pm-link-handling §9.5). Verifies the merge gate:
 *  - UC0/UC2/UC3-same fire the merge immediately (keep-survivor), no step.
 *  - UC1 opens the migrate prompt before any merge; accept → transfer,
 *    decline → keep-survivor, dismiss → no merge (back to panels).
 *  - UC3-different opens the selection step; confirm is disabled until a link is
 *    chosen; the chosen side maps to the right pmLink.
 *  - The pre-merge link badge renders on a linked panel only.
 *
 * next-intl is globally key-mocked in vitest.setup.ts, so translated strings
 * surface as their keys (e.g. "linkMigrateAccept"); panels are scoped by their
 * `aria-label` (the story identifier).
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

const mergeDuplicate = vi.fn(async () => ({
	survivorId: "a",
	duplicateId: "b",
	survivorExternalId: null,
}));
const dismissDuplicate = vi.fn(async () => ({ dismissed: true }));
const proposeDuplicateMerge = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				mergeDuplicate: (...args: unknown[]) => mergeDuplicate(...args),
				dismissDuplicate: (...args: unknown[]) =>
					dismissDuplicate(...args),
				proposeDuplicateMerge: (...args: unknown[]) =>
					proposeDuplicateMerge(...args),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "" }),
}));

vi.mock("@saas/projects/lib/image-upload-utils", () => ({
	prepareImageForAi: vi.fn(async (file: File) => ({
		ok: true as const,
		file,
	})),
	// The upload hook calls this after compressImage. A mock without it
	// throws inside preparation; the default stub keeps the pre-existing
	// behaviour of these suites (every image is within budget).
	compressImageToBudget: vi.fn(async (file: File) => ({
		file,
		withinBudget: true,
	})),
	resolveStoryImageUrls: vi.fn(async () => ({})),
}));

vi.mock("@saas/shared/components/copilot/MessageAttachmentList", () => ({
	MessageAttachmentList: () => null,
}));

// Radix/JSDOM shims (mirrors ConflictResolveDialog.test.tsx).
if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
	(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
}
if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

import {
	type DuplicateLink,
	type DuplicateLinkStory,
	DuplicateResolveDialog,
} from "../DuplicateResolveDialog";

function makeStory(
	id: string,
	identifier: string,
	link?: { externalId: string },
): DuplicateLinkStory {
	return {
		id,
		identifier,
		title: `Title ${identifier}`,
		description: "A description.",
		acceptanceCriteria: "Given X, when Y, then Z.",
		kind: "FEATURE",
		draftingStage: "BACKLOG",
		externalId: link?.externalId ?? null,
		externalUrl: link
			? `https://gitlab.com/acme/app/-/issues/${link.externalId}`
			: null,
		externalMcpServerId: link ? "mcp-1" : null,
		pmAutoSyncEnabled: !!link,
		lastPmSyncStatus: link ? "SUCCESS" : null,
		lastSyncedAt: link ? "2026-05-01T00:00:00.000Z" : null,
		createdAt: "2026-04-01T00:00:00.000Z",
	};
}

function makeLink(
	storyA: DuplicateLinkStory,
	storyB: DuplicateLinkStory,
): DuplicateLink {
	return {
		id: "link-1",
		similarity: 0.9,
		confidence: 0.85,
		reasoning: null,
		storyA,
		storyB,
	};
}

function renderDialog(link: DuplicateLink) {
	const onOpenChange = vi.fn();
	const onResolved = vi.fn();
	render(
		<DuplicateResolveDialog
			open
			onOpenChange={onOpenChange}
			projectId="p1"
			organizationId={null}
			link={link}
			onResolved={onResolved}
		/>,
	);
	return { onOpenChange, onResolved };
}

/** Click the "Merge — keep this" button inside the panel for `identifier`. */
async function clickMerge(
	user: ReturnType<typeof userEvent.setup>,
	identifier: string,
) {
	const panel = screen.getByRole("region", { name: identifier });
	await user.click(
		within(panel).getByRole("button", { name: "mergeKeepAsIs" }),
	);
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("DuplicateResolveDialog — pre-merge link badge", () => {
	it("shows a PM-link badge on the linked panel only", () => {
		renderDialog(
			makeLink(
				makeStory("a", "F-A"),
				makeStory("b", "F-B", { externalId: "123" }),
			),
		);
		// Exactly one badge (the linked side B); the unlinked side A has none.
		expect(screen.getByLabelText("linkBadgeAria")).toBeInTheDocument();
	});
});

describe("DuplicateResolveDialog — UC0/UC2 fire immediately (no link step)", () => {
	it("UC2 (survivor linked, discarded unlinked): merges immediately with keep-survivor", async () => {
		const user = userEvent.setup();
		renderDialog(
			makeLink(
				makeStory("a", "F-A", { externalId: "111" }),
				makeStory("b", "F-B"),
			),
		);
		await clickMerge(user, "F-A");
		await waitFor(() =>
			expect(mergeDuplicate).toHaveBeenCalledWith(
				expect.objectContaining({
					survivorId: "a",
					duplicateId: "b",
					pmLink: "keep-survivor",
				}),
			),
		);
		expect(screen.queryByText("linkMigrateTitle")).not.toBeInTheDocument();
		expect(screen.queryByText("linkSelectTitle")).not.toBeInTheDocument();
	});

	it("UC0 (neither linked): merges immediately with keep-survivor", async () => {
		const user = userEvent.setup();
		renderDialog(makeLink(makeStory("a", "F-A"), makeStory("b", "F-B")));
		await clickMerge(user, "F-A");
		await waitFor(() =>
			expect(mergeDuplicate).toHaveBeenCalledWith(
				expect.objectContaining({ pmLink: "keep-survivor" }),
			),
		);
	});
});

describe("DuplicateResolveDialog — UC1 migrate prompt", () => {
	const uc1 = () =>
		makeLink(
			makeStory("a", "F-A"),
			makeStory("b", "F-B", { externalId: "222" }),
		);

	it("opens the migrate prompt instead of merging, then transfers on accept", async () => {
		const user = userEvent.setup();
		renderDialog(uc1());
		await clickMerge(user, "F-A");
		// Step shown; no merge yet.
		expect(await screen.findByText("linkMigrateTitle")).toBeInTheDocument();
		expect(mergeDuplicate).not.toHaveBeenCalled();
		// Accept → transfer the discarded's link to the survivor.
		await user.click(
			screen.getByRole("button", { name: "linkMigrateAccept" }),
		);
		await waitFor(() =>
			expect(mergeDuplicate).toHaveBeenCalledWith(
				expect.objectContaining({
					survivorId: "a",
					duplicateId: "b",
					pmLink: "transfer-from-duplicate",
				}),
			),
		);
	});

	it("merges with keep-survivor on decline", async () => {
		const user = userEvent.setup();
		renderDialog(uc1());
		await clickMerge(user, "F-A");
		await user.click(
			await screen.findByRole("button", { name: "linkMigrateDecline" }),
		);
		await waitFor(() =>
			expect(mergeDuplicate).toHaveBeenCalledWith(
				expect.objectContaining({ pmLink: "keep-survivor" }),
			),
		);
	});

	it("dismiss (cancel) does not merge and returns to the panels", async () => {
		const user = userEvent.setup();
		renderDialog(uc1());
		await clickMerge(user, "F-A");
		await screen.findByText("linkMigrateTitle");
		await user.click(screen.getByRole("button", { name: "cancel" }));
		expect(mergeDuplicate).not.toHaveBeenCalled();
		// Panels are back.
		expect(screen.getByRole("region", { name: "F-A" })).toBeInTheDocument();
		expect(screen.queryByText("linkMigrateTitle")).not.toBeInTheDocument();
	});

	it("the migrate step has no obvious accessibility violations", async () => {
		const user = userEvent.setup();
		const { container } = (() => {
			const r = renderDialog(uc1());
			return { container: document.body, ...r };
		})();
		await clickMerge(user, "F-A");
		await screen.findByText("linkMigrateTitle");
		expect(await axe(container)).toHaveNoViolations();
	});
});

describe("DuplicateResolveDialog — UC3 different links", () => {
	const uc3 = () =>
		makeLink(
			makeStory("a", "F-A", { externalId: "AAA" }),
			makeStory("b", "F-B", { externalId: "BBB" }),
		);

	it("opens the selection step with a disabled confirm until a link is chosen", async () => {
		const user = userEvent.setup();
		renderDialog(uc3());
		await clickMerge(user, "F-A");
		expect(await screen.findByText("linkSelectTitle")).toBeInTheDocument();
		expect(mergeDuplicate).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "linkSelectConfirm" }),
		).toBeDisabled();
	});

	it("selecting the discarded item's link confirms with transfer-from-duplicate", async () => {
		const user = userEvent.setup();
		renderDialog(uc3());
		await clickMerge(user, "F-A");
		await screen.findByText("linkSelectTitle");
		const radios = screen.getAllByRole("radio");
		expect(radios).toHaveLength(2);
		// radios[0] = survivor's link, radios[1] = discarded's link.
		await user.click(radios[1]);
		const confirm = screen.getByRole("button", {
			name: "linkSelectConfirm",
		});
		expect(confirm).toBeEnabled();
		await user.click(confirm);
		await waitFor(() =>
			expect(mergeDuplicate).toHaveBeenCalledWith(
				expect.objectContaining({
					survivorId: "a",
					duplicateId: "b",
					pmLink: "transfer-from-duplicate",
				}),
			),
		);
	});

	it("selecting the survivor's own link confirms with keep-survivor", async () => {
		const user = userEvent.setup();
		renderDialog(uc3());
		await clickMerge(user, "F-A");
		await screen.findByText("linkSelectTitle");
		const radios = screen.getAllByRole("radio");
		await user.click(radios[0]);
		await user.click(
			screen.getByRole("button", { name: "linkSelectConfirm" }),
		);
		await waitFor(() =>
			expect(mergeDuplicate).toHaveBeenCalledWith(
				expect.objectContaining({ pmLink: "keep-survivor" }),
			),
		);
	});
});
