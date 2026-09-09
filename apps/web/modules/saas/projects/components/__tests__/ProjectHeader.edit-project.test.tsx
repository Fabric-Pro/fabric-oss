/**
 * Where the "Edit Project" button goes (Fizzy #2247 follow-up).
 *
 * The button has always pushed an ACTIVE project at the creation route as
 * `?step=1&projectId=`, which is the requirements/code mismatch the card
 * names. With SIMPLIFIED_PROJECT_CREATION on, that route now sends an ACTIVE
 * project straight back to the project — so the button navigated to the page
 * it was already on and read as dead.
 *
 * On, editing an active project goes to Settings, which owns the name, the
 * brief, the phase and the expected development start date. Off, the button
 * must behave exactly as it did before, or the rollback lever would be
 * changing a second thing as a side effect.
 *
 * A DRAFT resumes in the creation flow under either value: it has never been
 * created, so there is nothing in Settings to edit.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pushMock, useFeatureFlagMock, navigateToSettingsMock } = vi.hoisted(
	() => ({
		pushMock: vi.fn(),
		useFeatureFlagMock: vi.fn(),
		navigateToSettingsMock: vi.fn(),
	}),
);

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
	useTranslations: () => (key: string) => key,
}));

vi.mock("@saas/organizations/hooks", () => ({
	useBasePath: () => "/app/example-org",
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => useFeatureFlagMock(key),
}));

vi.mock("../settings-tab-navigation", () => ({
	navigateToProjectSettingsTab: (...args: unknown[]) =>
		navigateToSettingsMock(...args),
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

	it("opens Settings for an ACTIVE project instead of the creation route", async () => {
		renderHeader("ACTIVE");
		await clickEdit();

		expect(navigateToSettingsMock).toHaveBeenCalledWith(
			"proj-1",
			"general",
		);
		// The bounce-back that made the button look dead.
		expect(pushMock).not.toHaveBeenCalled();
	});

	it("still resumes a DRAFT in the creation flow", async () => {
		renderHeader("DRAFT");
		await clickEdit();

		expect(pushMock).toHaveBeenCalledWith(
			"/app/example-org/projects/new?projectId=proj-1",
		);
		expect(navigateToSettingsMock).not.toHaveBeenCalled();
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
		expect(navigateToSettingsMock).not.toHaveBeenCalled();
	});

	it("sends a DRAFT to the wizard with no step", async () => {
		renderHeader("DRAFT");
		await clickEdit();

		expect(pushMock).toHaveBeenCalledWith(
			"/app/example-org/projects/new?projectId=proj-1",
		);
	});
});
