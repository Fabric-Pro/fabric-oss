/**
 * Fizzy #2457 follow-up: the organization API keys table stored `expiresAt`
 * and every consumer (creation cap, the CLI-connection dialog, both protocol
 * hosts' auth checks) already treated it as load-bearing, but the table
 * itself rendered no expiry information at all — a key died silently and the
 * holder's first signal was their tool breaking mid-task.
 *
 * These tests pin the three lifetime states a viewer (sighted or on a screen
 * reader) must be able to tell apart at a glance, plus the "nothing to see
 * here" baseline for a key comfortably in date:
 *
 *  - expired: dead weight, must read as "Expired" in text, not just color
 *  - expiring soon (within the 14-day window — see
 *    `EXPIRING_SOON_WINDOW_DAYS` in the component): a warning ahead of the
 *    cliff, with the absolute date still reachable alongside the relative
 *    phrase
 *  - no expiry (`expiresAt: null`): said plainly, not left blank
 *  - comfortably in date: shows the plain date, no warning decoration
 *
 * Assertions target text content a user or assistive technology would
 * perceive (labels, dates), not class names or badge variants.
 */

import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
});

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: {
			id: "user-owner",
			name: "Pat Owner",
			email: "pat@example.com",
		},
	}),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		isOrgContext: true,
		userRole: "owner",
	}),
}));

const listApiKeysMock = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		organizations: {
			apiKeys: {
				list: (...args: unknown[]) => listApiKeysMock(...args),
				create: vi.fn(),
				delete: vi.fn(),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrganizationApiKeysSettings } from "../OrganizationApiKeysSettings";

// Offsets from the real current time rather than a frozen clock: the
// component reads `new Date()` at render time, and `findByText`'s polling
// needs real timers to resolve, so tests anchor to `Date.now()` instead of
// fighting fake-timer/async interaction.
const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): Date {
	return new Date(Date.now() + days * DAY_MS);
}

function makeKey(
	overrides: Partial<{
		id: string;
		name: string;
		expiresAt: Date | null;
	}>,
) {
	return {
		id: overrides.id ?? "key-id",
		name: overrides.name ?? "Test Key",
		keyPrefix: `org_${overrides.id ?? "key-id"}`,
		scopes: ["mcp:read"],
		expiresAt: overrides.expiresAt ?? null,
		lastUsedAt: null,
		usageCount: 0,
		isActive: true,
		createdAt: new Date("2025-01-01T00:00:00.000Z"),
		createdBy: {
			id: "user-owner",
			name: "Pat Owner",
			email: "pat@example.com",
		},
	};
}

function renderWithClient() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<OrganizationApiKeysSettings />
		</QueryClientProvider>,
	);
}

function formatAbsoluteDate(date: Date) {
	return date.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

async function findRowByKeyName(name: string) {
	const cell = await screen.findByText(name);
	const row = cell.closest("tr");
	if (!row) {
		throw new Error(`No table row found for key "${name}"`);
	}
	return row as HTMLElement;
}

/**
 * Matches the one element whose OWN text (not a descendant's, not an
 * ancestor's) contains `text`. Plain `textContent` checks match every
 * ancestor up to the row too, since `textContent` includes descendants —
 * this narrows to the leaf that actually carries the string, the standard
 * pattern for text split across inline elements.
 */
function withOwnTextIncluding(text: string) {
	return (_content: string, node: Element | null) => {
		if (!node?.textContent?.includes(text)) {
			return false;
		}
		return Array.from(node.children).every(
			(child) => !child.textContent?.includes(text),
		);
	};
}

afterEach(() => {
	listApiKeysMock.mockReset();
});

describe("OrganizationApiKeysSettings — expiry visibility (Fizzy #2457)", () => {
	it("marks an expired key as Expired in text, not color alone, with the absolute date reachable", async () => {
		const expiredAt = daysFromNow(-12); // 12 days in the past
		listApiKeysMock.mockResolvedValue([
			makeKey({
				id: "key-expired",
				name: "Expired Key",
				expiresAt: expiredAt,
			}),
		]);

		renderWithClient();

		const row = await findRowByKeyName("Expired Key");

		// The state is spelled out as text — perceivable without distinguishing
		// the badge's hue and identical to what a screen reader announces.
		expect(within(row).getByText("Expired")).toBeInTheDocument();

		// The absolute date must still be reachable next to the state label —
		// a relative phrase alone ("12 days ago") would lose it.
		expect(
			within(row).getByText(
				withOwnTextIncluding(formatAbsoluteDate(expiredAt)),
			),
		).toBeInTheDocument();

		// The decorative icon must not be announced as its own element to
		// assistive tech — it backs up the text, it doesn't replace it.
		const icon = row.querySelector("svg[aria-hidden='true']");
		expect(icon).toBeInTheDocument();
	});

	it("flags a key expiring inside the warning window as Expiring soon, with the date still shown", async () => {
		// 9 days out: inside the component's 14-day "expiring soon" window,
		// well ahead of the 90-day CLI-issued key lifetime.
		const soonAt = daysFromNow(9);
		listApiKeysMock.mockResolvedValue([
			makeKey({
				id: "key-expiring-soon",
				name: "Soon Key",
				expiresAt: soonAt,
			}),
		]);

		renderWithClient();

		const row = await findRowByKeyName("Soon Key");

		expect(within(row).getByText("Expiring soon")).toBeInTheDocument();
		expect(
			within(row).getByText(
				withOwnTextIncluding(formatAbsoluteDate(soonAt)),
			),
		).toBeInTheDocument();

		// Must not simultaneously read as fully expired.
		expect(within(row).queryByText("Expired")).not.toBeInTheDocument();
	});

	it("says 'No expiry' plainly for a key with expiresAt: null, rather than leaving the cell blank", async () => {
		listApiKeysMock.mockResolvedValue([
			makeKey({
				id: "key-no-expiry",
				name: "Forever Key",
				expiresAt: null,
			}),
		]);

		renderWithClient();

		const row = await findRowByKeyName("Forever Key");
		expect(within(row).getByText("No expiry")).toBeInTheDocument();
		expect(within(row).queryByText("Expired")).not.toBeInTheDocument();
		expect(
			within(row).queryByText("Expiring soon"),
		).not.toBeInTheDocument();
	});

	it("shows a plain date with no warning decoration for a key comfortably in date", async () => {
		// 150 days out: nowhere near the 14-day warning window.
		const farFuture = daysFromNow(150);
		listApiKeysMock.mockResolvedValue([
			makeKey({
				id: "key-active",
				name: "Healthy Key",
				expiresAt: farFuture,
			}),
		]);

		renderWithClient();

		const row = await findRowByKeyName("Healthy Key");

		// The date is present in plain form...
		expect(
			within(row).getByText(
				withOwnTextIncluding(formatAbsoluteDate(farFuture)),
			),
		).toBeInTheDocument();

		// ...but neither warning state is present — no false alarm.
		expect(within(row).queryByText("Expired")).not.toBeInTheDocument();
		expect(
			within(row).queryByText("Expiring soon"),
		).not.toBeInTheDocument();
	});
});
