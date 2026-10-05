/**
 * What the `ConnectCliDialog` test files share: the fixtures, the mounting
 * surface and the browser stubs. The `@shared/lib/orpc-client` mock stays in
 * each test file, because `vi.mock` is hoisted there; it reads `createKeyMock`
 * from `./connect-dialog-mocks`.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { vi } from "vitest";
import type { ConnectCliPurpose, LocalSetupRoute } from "../ConnectCliDialog";
import { ConnectCliDialog } from "../ConnectCliDialog";
import { createKeyMock } from "./connect-dialog-mocks";

export const ORGANIZATION_ID = "org-hosting-the-project";
export const ORGANIZATION_SLUG = "example-org";
export const PROJECT_NAME = "Checkout Rewrite";
export const PROJECT_ID = "project-checkout-rewrite";

/** The one URL every tool in the dialog connects to: the project's own gateway. */
export const PROJECT_GATEWAY = `${window.location.origin}/api/mcp-gateway/projects/${PROJECT_ID}`;
export const RAW_KEY = "org_1a2b3c4d_ZXhhbXBsZS1zZWNyZXQtdmFsdWU";

/**
 * What `/.well-known/fabric-cli.json` answers: a tarball built for the page the
 * tests render. Its own `tarball` host is deliberately not the page's (it is
 * the host that answered, which behind a proxy need not be the address the
 * person is on): the dialog must put the page's own origin in the command.
 */
const DISCOVERY_DOCUMENT = {
	version: "0.4.0",
	spec: 1,
	integrity:
		"sha512-gs0KTkSwaASijxIqwSDGS2+zgB7ztmUss3KGk2FSJtWwW1lV6xyxvhfPm30zh14w8/A1yEfFl+kz96Ujga5gDg==",
	minSupported: "0.4.0",
	nodeRange: ">=22",
	origin: window.location.origin as string | null,
	tarball: "https://configured-host.example.com/cli/fabric-0.4.0.tgz",
};

/** The same tarball, built for no address at all (the build could not know it). */
export const UNBAKED_DOCUMENT = { ...DISCOVERY_DOCUMENT, origin: null };

/** The same tarball, built for an address other than the page's. */
export const OTHER_ORIGIN_DOCUMENT = {
	...DISCOVERY_DOCUMENT,
	origin: "https://built-for.example.com",
};

/** The start of every setup line, on a page the tarball is built for. */
export const INIT = `npx -y ${window.location.origin}/cli/fabric-0.4.0.tgz instructions init`;

/** The same start, on a page it is not built for, which names the address. */
export const INIT_WITH_BASE_URL = `${INIT} --base-url ${window.location.origin}`;

export const REPOSITORY_ROUTE: Extract<
	LocalSetupRoute,
	{ kind: "repository" }
> = {
	kind: "repository",
	provider: "GITHUB",
	repositoryLabel: "example-org/instructions",
	cloneUrl: "https://github.com/example-org/instructions.git",
	directory: "instructions",
	ref: "main",
	rootPath: "agents",
};

export const fetchMock = vi.fn();

export const clipboardWrite = vi.fn(async () => {});

export function discoveryResponse(
	status = 200,
	body: unknown = DISCOVERY_DOCUMENT,
) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function issuedKeyFixture() {
	return {
		id: "key-1",
		name: "Coding CLI (created from the connect prompt)",
		keyPrefix: "org_1a2b3c4d",
		rawKey: RAW_KEY,
		scopes: ["mcp:read"],
		expiresAt: new Date("2026-12-09T00:00:00.000Z"),
		createdAt: new Date("2026-09-10T00:00:00.000Z"),
	};
}

/** The reset every test file runs before each test. */
export function installBrowserStubs() {
	createKeyMock.mockReset();
	createKeyMock.mockResolvedValue(issuedKeyFixture());
	clipboardWrite.mockReset();
	clipboardWrite.mockResolvedValue(undefined);
	fetchMock.mockReset();
	fetchMock.mockImplementation(async () => discoveryResponse());
	vi.stubGlobal("fetch", fetchMock);
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: clipboardWrite },
	});
}

function Wrapper({ children }: { children: ReactNode }) {
	// Created once per mount, not once per render: a fresh client on every
	// render would drop the mutation's own pending/error state mid-flow.
	const [client] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { retry: false },
					mutations: { retry: false },
				},
			}),
	);
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

/**
 * Mirrors how the two mounting surfaces are required to use this view: the
 * control that opens it sits inside the eligibility-gated subtree, the dialog
 * itself sits OUTSIDE it. `eligible` is a prop rather than harness state so a
 * test can flip it with `rerender`, standing in for the readiness refetch that
 * flips it in production — clicking a harness control would not work, because
 * a modal dialog puts the rest of the document behind `pointer-events: none`.
 */
export function Host({
	startOpen = false,
	eligible = true,
	purpose,
	localSetup,
	onKeyIssued,
}: {
	startOpen?: boolean;
	eligible?: boolean;
	purpose?: ConnectCliPurpose;
	localSetup?: LocalSetupRoute | null;
	onKeyIssued?: () => void;
}) {
	const [open, setOpen] = useState(startOpen);

	return (
		<>
			{eligible && (
				<button type="button" onClick={() => setOpen(true)}>
					Connect a coding tool
				</button>
			)}
			<ConnectCliDialog
				open={open}
				onOpenChange={setOpen}
				organizationId={ORGANIZATION_ID}
				organizationSlug={ORGANIZATION_SLUG}
				projectName={PROJECT_NAME}
				purpose={purpose}
				projectId={PROJECT_ID}
				localSetup={localSetup}
				onKeyIssued={onKeyIssued}
			/>
		</>
	);
}

export function renderWithQueryClient(ui: ReactNode) {
	return render(ui, { wrapper: Wrapper });
}

export function renderHost(props?: {
	startOpen?: boolean;
	purpose?: ConnectCliPurpose;
	localSetup?: LocalSetupRoute | null;
	onKeyIssued?: () => void;
}) {
	return renderWithQueryClient(<Host {...props} />);
}

/** The coding-instructions dialog, open, for a repository project unless told otherwise. */
export function renderInstructions(
	localSetup: LocalSetupRoute | null = REPOSITORY_ROUTE,
) {
	return renderHost({
		startOpen: true,
		purpose: "coding-instructions",
		localSetup,
	});
}

/**
 * `userEvent.setup()` installs its own clipboard stub over
 * `navigator.clipboard`, so the spy has to go on afterwards or every write
 * lands in userEvent's stub and the assertion sees no calls.
 */
export function setupUser() {
	const user = userEvent.setup();
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: clipboardWrite },
	});
	return user;
}

export function configurationText() {
	return screen.getByTestId("connect-cli-configuration").textContent ?? "";
}

/** The setup line's block, once the deployment has said what it serves. */
export function setupLine() {
	return screen.findByTestId("agent-sign-in-setup-line");
}

/** The text of the live region every copy control announces through. */
export function liveRegionText() {
	return document.querySelector('[aria-live="polite"]')?.textContent;
}

/**
 * An externally-resolvable promise, for pinning `copy()`'s async ordering
 * against a mint or a close: the test drives exactly when
 * `navigator.clipboard.writeText()` settles relative to those, which a
 * same-tick `mockResolvedValue` cannot do.
 */
export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** Open the dialog, create a key and wait for the REAL secret to be on screen. */
export async function mintKey(user: ReturnType<typeof userEvent.setup>) {
	await user.click(
		await screen.findByRole("button", { name: /create key/i }),
	);
	await waitFor(() =>
		expect(
			screen.getByTestId("connect-cli-configuration"),
		).toBeInTheDocument(),
	);
}
