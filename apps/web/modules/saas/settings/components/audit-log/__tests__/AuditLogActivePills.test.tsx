/**
 * Tests for AuditLogActivePills — the removable filter chip row above
 * the table.
 *
 * The shared next-intl mock returns the bare i18n key for every call —
 * so labels render as `settings.auditLog.pills.labels.action` and the
 * remove aria-label renders as `settings.auditLog.pills.remove`. Tests
 * assert on:
 *  - the **value** half of the pill (rendered as user-facing text)
 *  - the i18n key emitted on container elements
 *  - the `onFiltersChange` callback receiving the correct next state
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuditLogActivePills } from "../AuditLogActivePills";
import {
	type AuditLogFiltersState,
	type AuditViewerUser,
	EMPTY_FILTERS_STATE,
} from "../types";

const ALICE: AuditViewerUser = {
	id: "user-1",
	email: "alice@example.com",
	name: "Alice",
};

function renderPills(over: Partial<AuditLogFiltersState> = {}) {
	const filters: AuditLogFiltersState = { ...EMPTY_FILTERS_STATE, ...over };
	const onChange = vi.fn();
	render(
		<AuditLogActivePills
			mode="organization"
			filters={filters}
			currentUser={ALICE}
			onFiltersChange={onChange}
		/>,
	);
	return { onChange, filters };
}

describe("AuditLogActivePills", () => {
	it("renders nothing when no filters are active", () => {
		const { container } = render(
			<AuditLogActivePills
				mode="organization"
				filters={EMPTY_FILTERS_STATE}
				currentUser={ALICE}
				onFiltersChange={vi.fn()}
			/>,
		);
		expect(container.firstChild).toBeNull();
	});

	it("renders a pill per active action", () => {
		renderPills({ actions: ["auth.login.success", "auth.logout"] });
		// Action labels fall back to descriptor label when the i18n key path
		// equals the returned value (mock returns the key as-is).
		expect(screen.getByText("Sign-in success")).toBeInTheDocument();
		expect(screen.getByText("Sign-out")).toBeInTheDocument();
	});

	it("removes a single action when its ✕ is clicked", () => {
		const { onChange } = renderPills({
			actions: ["auth.login.success", "auth.logout"],
		});
		// The aria-label is built via `t('...pills.remove', { label, value })`
		// — the mock returns the i18n key, but the button is still rendered.
		// Walk up to the Badge wrapper (data-slot="badge"), then its inner
		// remove button.
		const signInPill = screen
			.getByText("Sign-in success")
			.closest("[data-slot='badge']");
		expect(signInPill).not.toBeNull();
		const removeBtn = signInPill!.querySelector("button");
		expect(removeBtn).not.toBeNull();
		fireEvent.click(removeBtn!);
		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0]?.[0];
		expect(next.actions).toEqual(["auth.logout"]);
	});

	it("renders an active correlation ID pill with a truncated display", () => {
		renderPills({
			correlationId: "req_abcdef1234567890_long_tail_does_not_fit",
		});
		// Should be truncated to 12 chars + ellipsis (U+2026)
		expect(screen.getByText("req_abcdef12…")).toBeInTheDocument();
	});

	it("renders an actorType pill for each selected bucket (item 15)", () => {
		renderPills({ actorTypes: ["api_key", "system"] });
		expect(
			screen.getByText("settings.auditLog.filters.actorType.api_key"),
		).toBeInTheDocument();
		expect(
			screen.getByText("settings.auditLog.filters.actorType.system"),
		).toBeInTheDocument();
	});

	it("removes a single actorType bucket when its ✕ is clicked", () => {
		const { onChange } = renderPills({
			actorTypes: ["api_key", "system"],
		});
		const valueEl = screen.getByText(
			"settings.auditLog.filters.actorType.api_key",
		);
		const pillContainer = valueEl.closest("[data-slot='badge']");
		expect(pillContainer).not.toBeNull();
		const removeBtn = pillContainer!.querySelector("button");
		expect(removeBtn).not.toBeNull();
		fireEvent.click(removeBtn!);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]?.[0].actorTypes).toEqual(["system"]);
	});

	it("renders ip-address pill", () => {
		renderPills({
			ipAddressContains: "10.0.",
		});
		expect(screen.getByText("10.0.")).toBeInTheDocument();
	});

	it("shows Clear all when 2+ pills are visible and clears all on click", () => {
		const { onChange } = renderPills({
			actions: ["auth.login.success"],
			ipAddressContains: "10.0.",
		});
		// The Clear all button text is `t('...pills.clearAll')` => bare key.
		const clearBtn = screen
			.getAllByRole("button")
			.find((btn) =>
				(btn.textContent ?? "").includes(
					"settings.auditLog.pills.clearAll",
				),
			);
		expect(clearBtn).toBeDefined();
		fireEvent.click(clearBtn!);
		expect(onChange).toHaveBeenCalledTimes(1);
		// EMPTY_FILTERS_STATE is returned exactly (org mode)
		expect(onChange.mock.calls[0]?.[0]).toEqual(EMPTY_FILTERS_STATE);
	});

	it("hides Clear all when only one pill is active", () => {
		renderPills({ actions: ["auth.login.success"] });
		const clearBtn = screen
			.queryAllByRole("button")
			.find((btn) =>
				(btn.textContent ?? "").includes(
					"settings.auditLog.pills.clearAll",
				),
			);
		expect(clearBtn).toBeUndefined();
	});

	it("does NOT render an actor pill for the personal-mode pinned user", () => {
		const filters: AuditLogFiltersState = {
			...EMPTY_FILTERS_STATE,
			actorIds: [ALICE.id],
		};
		const { container } = render(
			<AuditLogActivePills
				mode="personal"
				filters={filters}
				currentUser={ALICE}
				onFiltersChange={vi.fn()}
			/>,
		);
		// No pills at all — the only active filter is the default actor pin.
		expect(container.firstChild).toBeNull();
	});
});
