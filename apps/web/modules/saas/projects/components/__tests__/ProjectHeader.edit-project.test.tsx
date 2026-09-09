/**
 * Where the "Edit Project" button goes (Fizzy #2247 follow-up).
 *
 * The button has always pushed an ACTIVE project at the creation route as
 * `?step=1&projectId=`, which is the requirements/code mismatch the card
 * names. With SIMPLIFIED_PROJECT_CREATION on, that route now sends an ACTIVE
 * project straight back to the project — so the button navigated to the page
 * it was already on and read as dead.
 *
 * On, editing an active project goes to the edit screen, which asks for the
 * same four fields the creation form does. Off, the button must behave exactly
 * as it did before, or the rollback lever would be changing a second thing as
 * a side effect.
 *
 * A DRAFT resumes in the creation flow under either value: it has never been
 * created, so there is nothing live to edit.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pushMock, useFeatureFlagMock, tooltipKeyMock } = vi.hoisted(() => ({
	pushMock: vi.fn(),
	useFeatureFlagMock: vi.fn(),
	// Records which tooltip copy the header asks for. The tooltip itself is a
	// Radix popover that does not open under jsdom without a pointer harness,
	// and the branch worth pinning is which string is chosen, not whether Radix
	// can render it.
	tooltipKeyMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: pushMock,
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	usePathname: () => "/app/example-org/projects/proj-1",
	useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("next-intl", () => ({
	useTranslations: (namespace?: string) => (key: string) => {
		if (namespace === "tooltips.projectHeader") {
			tooltipKeyMock(key);
		}
		return key;
	},
}));

vi.mock("@saas/organizations/hooks", () => ({
	useBasePath: () => "/app/example-org",
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => useFeatureFlagMock(key),
}));

// Children the header composes but this test does not exercise. Each pulls in
// its own data hooks, and none of them decide where the edit button goes.
vi.mock("@saas/projects/components/ProjectFavoriteToggle", () => ({
	ProjectFavoriteToggle: () => null,
}));
vi.mock(
	"@saas/projects/components/readiness/ProjectReadinessIndicator",
	() => ({ ProjectReadinessIndicator: () => null }),
);
vi.mock("../ProjectPresenceBar", () => ({ ProjectPresenceBar: () => null }));
vi.mock("../ProjectTitleInlineEdit", () => ({
	ProjectTitleInlineEdit: ({ name }: { name: string }) => <span>{name}</span>,
}));

import { ProjectHeader } from "../ProjectHeader";

function makeProject(status: string) {
	return {
		id: "proj-1",
		name: "Example Project",
		description: null,
		status,
		projectTypes: [],
		icon: null,
		color: null,
		tags: null,
		techStack: null,
		features: null,
		goals: null,
		createdAt: new Date("2026-01-01"),
		updatedAt: new Date("2026-01-01"),
	};
}

function renderHeader(status = "ACTIVE") {
	return render(
		<ProjectHeader
			project={makeProject(status)}
			organizationId="org-1"
			canEdit
		/>,
	);
}

const clickEdit = async () => {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: /Edit Project/ }));
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("Edit Project — simplified creation on", () => {
	beforeEach(() => {
		useFeatureFlagMock.mockReturnValue(true);
	});

	it("opens the edit screen for an ACTIVE project", async () => {
		renderHeader("ACTIVE");
		await clickEdit();

		expect(pushMock).toHaveBeenCalledWith(
			"/app/example-org/projects/proj-1/edit",
		);
	});

	it("still resumes a DRAFT in the creation flow", async () => {
		renderHeader("DRAFT");
		await clickEdit();

		expect(pushMock).toHaveBeenCalledWith(
			"/app/example-org/projects/new?projectId=proj-1",
		);
	});

	// The wizard's tooltip names the repository link and integrations, which
	// the edit screen does not touch — they live in the project's own tabs and
	// settings now. Wrong copy under the new flow, right copy under the old.
	it("describes what the edit screen actually edits", async () => {
		renderHeader("ACTIVE");

		expect(tooltipKeyMock).toHaveBeenCalledWith("editProjectBasics");
		expect(tooltipKeyMock).not.toHaveBeenCalledWith("editProject");
	});

	// A DRAFT still resumes in the creation flow, where the wizard's own copy
	// is the accurate one.
	it("keeps the wizard's copy for a DRAFT", async () => {
		renderHeader("DRAFT");

		expect(tooltipKeyMock).toHaveBeenCalledWith("editProject");
	});

	it("reads the flag it claims to read", async () => {
		renderHeader("ACTIVE");
		expect(useFeatureFlagMock).toHaveBeenCalledWith(
			"SIMPLIFIED_PROJECT_CREATION",
		);
	});
});

describe("Edit Project — simplified creation off", () => {
	beforeEach(() => {
		useFeatureFlagMock.mockReturnValue(false);
	});

	// Rollback has to be exact: with the flag off this button must still reach
	// the wizard at the Brief step, exactly as it did before #2247.
	it("sends an ACTIVE project to the wizard at step 1", async () => {
		renderHeader("ACTIVE");
		await clickEdit();

		expect(pushMock).toHaveBeenCalledWith(
			"/app/example-org/projects/new?step=1&projectId=proj-1",
		);
	});

	it("keeps the wizard's tooltip, which is accurate for the wizard", async () => {
		renderHeader("ACTIVE");

		expect(tooltipKeyMock).toHaveBeenCalledWith("editProject");
		expect(tooltipKeyMock).not.toHaveBeenCalledWith("editProjectBasics");
	});

	it("sends a DRAFT to the wizard with no step", async () => {
		renderHeader("DRAFT");
		await clickEdit();

		expect(pushMock).toHaveBeenCalledWith(
			"/app/example-org/projects/new?projectId=proj-1",
		);
	});
});
