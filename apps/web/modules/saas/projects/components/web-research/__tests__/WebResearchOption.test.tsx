/**
 * The shared "Allow web research" checkbox, rendered with the real English
 * copy. Every state that cannot research (checking, check failed, providers
 * missing, a caller's blocked reason) must stay focusable, read unchecked,
 * ignore clicks and keys, and be described by the reason.
 */
import en from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The global setup echoes keys; this suite resolves the real messages.
vi.mock("next-intl", async () => await vi.importActual("next-intl"));

const organization = vi.hoisted(() => ({
	slug: "example-org" as string | null,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		organizationSlug: organization.slug,
		basePath: "/app/example-org",
	}),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: vi.fn(),
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	usePathname: () => "/",
	useSearchParams: () => new URLSearchParams(),
}));

import { NextIntlClientProvider } from "next-intl";
import { WebResearchOption } from "../WebResearchOption";

const copy = en.projects.documents.webResearch;
const SETTINGS_HREF = "/app/example-org/settings/search-providers";

type Props = ComponentProps<typeof WebResearchOption>;

function renderOption(overrides: Partial<Props> = {}) {
	const onCheckedChange = vi.fn();
	const props: Props = {
		checked: false,
		onCheckedChange,
		availability: { status: "available" },
		...overrides,
	};
	const view = render(
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			<WebResearchOption {...props} />
		</NextIntlClientProvider>,
	);
	return {
		...view,
		onCheckedChange: props.onCheckedChange as ReturnType<typeof vi.fn>,
		checkbox: screen.getByRole("checkbox", { name: copy.label }),
	};
}

/** Clicking, Space and clicking the label must all leave it alone. */
async function expectInert(
	checkbox: HTMLElement,
	onCheckedChange: ReturnType<typeof vi.fn>,
) {
	const user = userEvent.setup();
	await user.click(checkbox);
	checkbox.focus();
	await user.keyboard(" ");
	await user.click(screen.getByText(copy.label));
	expect(onCheckedChange).not.toHaveBeenCalled();
	expect(checkbox).toHaveAttribute("aria-checked", "false");
}

/** Blocked, but never `disabled`: Radix would take it out of the tab order. */
function expectBlockedButFocusable(checkbox: HTMLElement) {
	expect(checkbox).toHaveAttribute("aria-disabled", "true");
	expect(checkbox).not.toBeDisabled();
	expect(checkbox).not.toHaveAttribute("disabled");
	checkbox.focus();
	expect(checkbox).toHaveFocus();
}

beforeEach(() => {
	organization.slug = "example-org";
});

describe("WebResearchOption", () => {
	describe("when research is available", () => {
		it("renders unchecked, labelled, and enabled", () => {
			const { checkbox } = renderOption();

			expect(checkbox).toHaveAttribute("aria-checked", "false");
			expect(checkbox).not.toHaveAttribute("aria-disabled");
			expect(checkbox).toHaveAccessibleDescription(copy.hint);
			expect(screen.queryByRole("link")).toBeNull();
		});

		it("reports a tick to the caller", async () => {
			const user = userEvent.setup();
			const { checkbox, onCheckedChange } = renderOption();

			await user.click(checkbox);

			expect(onCheckedChange).toHaveBeenCalledTimes(1);
			expect(onCheckedChange).toHaveBeenCalledWith(true);
		});

		it("reports an untick when it is already checked", async () => {
			const user = userEvent.setup();
			const { checkbox, onCheckedChange } = renderOption({
				checked: true,
			});

			expect(checkbox).toHaveAttribute("aria-checked", "true");
			await user.click(checkbox);

			expect(onCheckedChange).toHaveBeenCalledWith(false);
		});

		it("toggles from the keyboard", async () => {
			const user = userEvent.setup();
			const { checkbox, onCheckedChange } = renderOption();

			checkbox.focus();
			await user.keyboard(" ");

			expect(onCheckedChange).toHaveBeenCalledWith(true);
		});
	});

	describe("when a search provider is missing", () => {
		const availability = {
			status: "unavailable",
			missing: ["search"],
		} as const;

		it("is aria-disabled but stays focusable", () => {
			const { checkbox } = renderOption({ availability });

			expectBlockedButFocusable(checkbox);
		});

		it("ignores clicks, Space and the label, and reads unchecked", async () => {
			const { checkbox, onCheckedChange } = renderOption({
				availability,
				checked: true,
			});

			expect(checkbox).toHaveAttribute("aria-checked", "false");
			await expectInert(checkbox, onCheckedChange);
		});

		it("is described by the missing search provider and the settings link", () => {
			const { checkbox } = renderOption({ availability });

			const reason = screen.getByTestId("web-research-reason");
			expect(
				checkbox.getAttribute("aria-describedby")?.split(" "),
			).toContain(reason.id);
			expect(checkbox).toHaveAccessibleDescription(
				expect.stringContaining(copy.missingSearch),
			);
			expect(checkbox).toHaveAccessibleDescription(
				expect.stringContaining(copy.settingsLink),
			);
			expect(reason).not.toHaveTextContent(copy.missingRead);
		});

		it("links to the organization's search provider settings, reachable by Tab", async () => {
			const user = userEvent.setup();
			const { checkbox } = renderOption({ availability });

			const link = screen.getByRole("link", { name: copy.settingsLink });
			expect(link).toHaveAttribute("href", SETTINGS_HREF);

			checkbox.focus();
			await user.tab();
			expect(link).toHaveFocus();
		});

		it("runs the caller's navigate hook when the link is followed", async () => {
			const user = userEvent.setup();
			const onNavigate = vi.fn();
			renderOption({ availability, onNavigate });

			const link = screen.getByRole("link", { name: copy.settingsLink });
			// jsdom does not navigate; the click handler is what is under test.
			link.addEventListener("click", (event) => event.preventDefault());
			await user.click(link);

			expect(onNavigate).toHaveBeenCalledTimes(1);
		});

		it("gives the reason without a link when there is no organization", () => {
			organization.slug = null;
			const { checkbox } = renderOption({ availability });

			expect(checkbox).toHaveAccessibleDescription(
				expect.stringContaining(copy.missingSearch),
			);
			expect(screen.queryByRole("link")).toBeNull();
		});
	});

	it("names the read provider when only that is missing", () => {
		const { checkbox } = renderOption({
			availability: { status: "unavailable", missing: ["read"] },
		});

		expectBlockedButFocusable(checkbox);
		const reason = screen.getByTestId("web-research-reason");
		expect(reason).toHaveTextContent(copy.missingRead);
		expect(reason).not.toHaveTextContent(copy.missingSearch);
		expect(
			screen.getByRole("link", { name: copy.settingsLink }),
		).toHaveAttribute("href", SETTINGS_HREF);
	});

	it("names both providers when both are missing", async () => {
		const { checkbox, onCheckedChange } = renderOption({
			availability: {
				status: "unavailable",
				missing: ["search", "read"],
			},
		});

		expectBlockedButFocusable(checkbox);
		expect(checkbox).toHaveAccessibleDescription(
			expect.stringContaining(copy.missingBoth),
		);
		expect(copy.missingBoth).toMatch(/search the web/);
		expect(copy.missingBoth).toMatch(/read web pages/);
		await expectInert(checkbox, onCheckedChange);
	});

	describe("while availability is loading", () => {
		it("says it is checking, not that something is missing", async () => {
			const { checkbox, onCheckedChange } = renderOption({
				availability: { status: "loading" },
				checked: true,
			});

			expectBlockedButFocusable(checkbox);
			expect(checkbox).toHaveAccessibleDescription(
				expect.stringContaining(copy.checking),
			);
			const reason = screen.getByTestId("web-research-reason");
			expect(reason).toHaveTextContent(copy.checking);
			expect(reason).not.toHaveTextContent(copy.missingSearch);
			expect(reason).not.toHaveTextContent(copy.missingRead);
			expect(reason).not.toHaveTextContent(copy.missingBoth);
			expect(screen.queryByRole("link")).toBeNull();
			await expectInert(checkbox, onCheckedChange);
		});
	});

	describe("when the availability check failed", () => {
		it("says the check failed and never reads checked", async () => {
			const { checkbox, onCheckedChange } = renderOption({
				availability: { status: "error" },
				checked: true,
			});

			expectBlockedButFocusable(checkbox);
			expect(checkbox).toHaveAccessibleDescription(
				expect.stringContaining(copy.checkFailed),
			);
			expect(screen.queryByRole("link")).toBeNull();
			await expectInert(checkbox, onCheckedChange);
		});
	});

	describe("with a blocked reason", () => {
		it("blocks an otherwise available option and gives that reason", async () => {
			const { checkbox, onCheckedChange } = renderOption({
				blockedReason: copy.fileSource,
				checked: true,
			});

			expectBlockedButFocusable(checkbox);
			expect(checkbox).toHaveAccessibleDescription(
				expect.stringContaining(copy.fileSource),
			);
			await expectInert(checkbox, onCheckedChange);
		});

		it("takes precedence over a missing-provider reason", () => {
			renderOption({
				blockedReason: copy.fileSource,
				availability: { status: "unavailable", missing: ["search"] },
			});

			const reason = screen.getByTestId("web-research-reason");
			expect(reason).toHaveTextContent(copy.fileSource);
			expect(reason).not.toHaveTextContent(copy.missingSearch);
			expect(screen.queryByRole("link")).toBeNull();
		});
	});

	it("shows the shorter hint in the compact variant", () => {
		const { checkbox } = renderOption({ variant: "compact" });

		expect(checkbox).toHaveAccessibleDescription(copy.compactHint);
		expect(screen.queryByText(copy.hint)).toBeNull();
	});

	it("keeps label and description ids distinct between two instances", () => {
		render(
			<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
				<WebResearchOption
					checked={false}
					onCheckedChange={vi.fn()}
					availability={{ status: "loading" }}
				/>
				<WebResearchOption
					checked={false}
					onCheckedChange={vi.fn()}
					availability={{ status: "error" }}
				/>
			</NextIntlClientProvider>,
		);

		const [first, second] = screen.getAllByRole("checkbox", {
			name: copy.label,
		});
		expect(first).toHaveAccessibleDescription(
			expect.stringContaining(copy.checking),
		);
		expect(second).toHaveAccessibleDescription(
			expect.stringContaining(copy.checkFailed),
		);
	});
});
