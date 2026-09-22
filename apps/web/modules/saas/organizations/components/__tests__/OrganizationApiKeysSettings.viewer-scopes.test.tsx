/**
 * Fizzy #2457 follow-up: an organization VIEWER may now create an API key, and
 * the create procedure clamps what that key may carry to a read-only set
 * (`READ_ONLY_ORG_API_KEY_SCOPES`). The procedure's input schema still defaults
 * `scopes` to `["mcp:read", "mcp:write"]`, and that default is not a viewer's
 * set — so a viewer who simply opened this dialog and pressed Create was
 * refused with FORBIDDEN on the write half, having ticked nothing.
 *
 * The schema default is deliberately untouched: moving it would change what
 * every member's key carries. The fix belongs on the caller that knows the
 * role, which is this component.
 *
 * These tests pin what the create path SENDS, because that is the whole of the
 * bug: what a request carries, for the role holding the dialog open.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
			id: "user-viewer",
			name: "Robin Viewer",
			email: "robin@example.com",
		},
	}),
}));

/** Driven per test: the same component, held open by a different role. */
let userRole = "viewer";

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		isOrgContext: true,
		userRole,
	}),
}));

const listApiKeysMock = vi.fn();
const createApiKeyMock = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		organizations: {
			apiKeys: {
				list: (...args: unknown[]) => listApiKeysMock(...args),
				create: (...args: unknown[]) => createApiKeyMock(...args),
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

/**
 * Every scope the create procedure permits a read-only role, mirrored from
 * `READ_ONLY_ORG_API_KEY_SCOPES`. Restated here rather than imported from the
 * component: the point of the test is that the two agree, and importing the
 * component's own copy would assert only that it agrees with itself.
 */
const READ_ONLY_SCOPES = new Set([
	"mcp:read",
	"projects:read",
	"agents:read",
	"agents:stream",
	"orgs:read",
	"features:read",
	"workspaces:read",
	"workflows:read",
	"frames:read",
	"instructions:read",
	// The one WRITE scope a viewer may hold (Fizzy #2539): it reaches the
	// proposal path, which is what a viewer can already do in the Coding
	// Instructions tab on `INSTRUCTION_READ`.
	"instructions:write",
	"chats:read",
	"system_health:read",
	"status_updates:read",
]);

function renderSettings() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<OrganizationApiKeysSettings />
		</QueryClientProvider>,
	);
}

async function openCreateDialogAndSubmit(name: string) {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: /create api key/i }));
	await user.type(await screen.findByLabelText("Key Name"), name);
	await user.click(screen.getByRole("button", { name: "Create Key" }));
	return user;
}

beforeEach(() => {
	vi.clearAllMocks();
	userRole = "viewer";
	listApiKeysMock.mockResolvedValue([]);
	createApiKeyMock.mockResolvedValue({
		id: "key-1",
		name: "CLI",
		keyPrefix: "org_1a2b3c4d",
		rawKey: "org_1a2b3c4d_ZXhhbXBsZS1zZWNyZXQtdmFsdWU",
		scopes: ["mcp:read"],
		expiresAt: null,
		createdAt: new Date("2026-09-11T00:00:00.000Z"),
	});
});

describe("OrganizationApiKeysSettings — a read-only role's create request", () => {
	/**
	 * The regression itself. A viewer who touches nothing but the name must not
	 * be handed the member default, because the procedure refuses the whole
	 * request on its write half.
	 */
	it("sends only scopes the viewer's role can hold", async () => {
		renderSettings();

		await openCreateDialogAndSubmit("Coding CLI");

		await waitFor(() => expect(createApiKeyMock).toHaveBeenCalledTimes(1));
		const sent = createApiKeyMock.mock.calls[0][0];
		expect(sent.scopes).toEqual(["mcp:read"]);
		for (const scope of sent.scopes) {
			expect(READ_ONLY_SCOPES.has(scope)).toBe(true);
		}
		expect(sent.scopes).not.toContain("mcp:write");
	});

	/** The picker cannot compose a request the server is bound to refuse. */
	it("withholds the scopes a read-only role cannot be granted", async () => {
		const user = userEvent.setup();
		renderSettings();

		await user.click(
			screen.getByRole("button", { name: /create api key/i }),
		);

		expect(await screen.findByLabelText("MCP Read")).toBeInTheDocument();
		// A viewer may request the new instructions scope too — it maps to
		// `INSTRUCTION_READ`, which the org viewer permission set already
		// carries.
		expect(
			await screen.findByLabelText("Instructions Read"),
		).toBeInTheDocument();
		// And the one WRITE scope on the read-only list (Fizzy #2539). It
		// reaches the proposal path only — a suggestion an editor approves —
		// which is what a viewer can already do in the Coding Instructions
		// tab. Withholding it here would make the key narrower than the
		// browser for the same person.
		expect(
			await screen.findByLabelText("Instructions Write"),
		).toBeInTheDocument();
		// Its sibling is withheld, for the opposite reason: publishing without
		// review needs `INSTRUCTION_CREATE`, which a viewer does not hold, so
		// the server would refuse the whole request.
		expect(
			screen.queryByLabelText("Instructions Publish"),
		).not.toBeInTheDocument();
		expect(screen.queryByLabelText("MCP Write")).not.toBeInTheDocument();
		expect(
			screen.queryByLabelText("Projects Write"),
		).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Full Access")).not.toBeInTheDocument();
	});

	/** A shorter list with no explanation reads as a bug rather than a rule. */
	it("says why the list is shorter", async () => {
		const user = userEvent.setup();
		renderSettings();

		await user.click(
			screen.getByRole("button", { name: /create api key/i }),
		);

		expect(
			await screen.findByText(
				/Your role in this organization is read-only/i,
			),
		).toBeInTheDocument();
	});

	/**
	 * The other half of the fix: nothing changes for anybody else. A member's
	 * key is not clamped — the procedure clamps the read-only role alone — so
	 * the default pair must survive for them.
	 */
	it("leaves a member's default untouched", async () => {
		userRole = "member";
		renderSettings();

		await openCreateDialogAndSubmit("Production Agent");

		await waitFor(() => expect(createApiKeyMock).toHaveBeenCalledTimes(1));
		expect(createApiKeyMock.mock.calls[0][0].scopes).toEqual([
			"mcp:read",
			"mcp:write",
		]);
	});

	it("still offers a member the write scopes", async () => {
		userRole = "member";
		const user = userEvent.setup();
		renderSettings();

		await user.click(
			screen.getByRole("button", { name: /create api key/i }),
		);

		expect(await screen.findByLabelText("MCP Write")).toBeInTheDocument();
		expect(
			screen.queryByText(/Your role in this organization is read-only/i),
		).not.toBeInTheDocument();
	});
});
