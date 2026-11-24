import messages from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	generateServerSecret,
	getLoopbackHostMismatchUrl,
	RemoteAgentServerPicker,
	resolvePersonalLoopbackUrl,
} from "../RemoteAgentServerPicker";

const f = vi.hoisted(() => ({
	toastError: vi.fn(),
	connect: vi.fn(),
	disconnect: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		codingRuns: {
			remoteServers: {
				connect: f.connect,
				disconnect: f.disconnect,
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { error: f.toastError },
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) =>
		messages.projects.remoteAgents[
			key as keyof typeof messages.projects.remoteAgents
		] as string,
}));

function renderPicker(
	props: Partial<Parameters<typeof RemoteAgentServerPicker>[0]> = {},
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<RemoteAgentServerPicker
				projectId="example-project"
				organizationId="example-org"
				servers={[]}
				canShare={true}
				value=""
				onChange={vi.fn()}
				{...props}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it.each([true, false])(
	"offers the deployment server only when configured: %s",
	(configured) => {
		renderPicker({
			canShare: false,
			hasDefaultServer: configured,
		});
		expect(
			Boolean(
				screen.queryByRole("option", { name: "Deployment server" }),
			),
		).toBe(configured);
	},
);

describe("RemoteAgentServerPicker loopback helpers", () => {
	it("resolves personal loopback URLs to match the Portal loopback hostname", () => {
		expect(resolvePersonalLoopbackUrl("localhost")).toBe(
			"http://localhost:9100",
		);
		expect(resolvePersonalLoopbackUrl("127.0.0.1")).toBe(
			"http://127.0.0.1:9100",
		);
		expect(resolvePersonalLoopbackUrl("[::1]")).toBe("http://[::1]:9100");
		expect(resolvePersonalLoopbackUrl("::1")).toBe("http://[::1]:9100");
		expect(resolvePersonalLoopbackUrl("portal.example.com")).toBe(
			"http://localhost:9100",
		);
		expect(resolvePersonalLoopbackUrl(undefined)).toBe(
			"http://localhost:9100",
		);
	});

	it("detects cross-site loopback hostname mismatches while preserving port", () => {
		expect(
			getLoopbackHostMismatchUrl("http://127.0.0.1:19125", "localhost"),
		).toBe("http://localhost:19125");
		expect(
			getLoopbackHostMismatchUrl("http://localhost:9100", "127.0.0.1"),
		).toBe("http://127.0.0.1:9100");
		expect(
			getLoopbackHostMismatchUrl("http://localhost:9100", "localhost"),
		).toBeNull();
		expect(
			getLoopbackHostMismatchUrl(
				"https://agents.example.com",
				"localhost",
			),
		).toBeNull();
	});
});

describe("RemoteAgentServerPicker", () => {
	it("uses localhost:9100 for the personal preset on localhost and replaces it when switching to the organization preset", async () => {
		renderPicker();

		const personalPresetBtn = await screen.findByRole("button", {
			name: /Personal Fabric Agents Remote Server \(localhost:9100\)/i,
		});
		fireEvent.click(personalPresetBtn);

		const urlInput = screen.getByLabelText(
			"Server URL",
		) as HTMLInputElement;
		expect(urlInput.value).toBe("http://localhost:9100");
		expect(
			screen.queryByTestId("loopback-host-mismatch-hint"),
		).not.toBeInTheDocument();

		fireEvent.click(
			screen.getByRole("button", {
				name: /Organization Fabric Agents Remote Server/i,
			}),
		);
		expect(urlInput.value).toBe("https://agents.example.com");
	});

	it("uses 127.0.0.1:9100 when the Portal is opened via 127.0.0.1", async () => {
		vi.stubGlobal("location", {
			...window.location,
			hostname: "127.0.0.1",
			origin: "http://127.0.0.1:3032",
		});

		renderPicker();

		const personalPresetBtn = await screen.findByRole("button", {
			name: /Personal Fabric Agents Remote Server \(127\.0\.0\.1:9100\)/i,
		});
		fireEvent.click(personalPresetBtn);

		const urlInput = screen.getByLabelText(
			"Server URL",
		) as HTMLInputElement;
		expect(urlInput.value).toBe("http://127.0.0.1:9100");
	});

	it("offers a one-click hostname fix when the user enters a mismatched loopback address", async () => {
		renderPicker();

		const urlInput = screen.getByLabelText(
			"Server URL",
		) as HTMLInputElement;
		fireEvent.change(urlInput, {
			target: { value: "http://127.0.0.1:19125" },
		});

		expect(
			await screen.findByTestId("loopback-host-mismatch-hint"),
		).toHaveTextContent("SameSite=Strict");

		fireEvent.click(
			screen.getByRole("button", {
				name: "Use http://localhost:19125",
			}),
		);

		expect(urlInput.value).toBe("http://localhost:19125");
		expect(
			screen.queryByTestId("loopback-host-mismatch-hint"),
		).not.toBeInTheDocument();
	});

	it("renders actionable readiness errors returned by connectRemoteServer", async () => {
		f.connect.mockRejectedValueOnce(
			new Error(
				"This Fabric Agents server is reachable, but it has no workspace yet. Open the server Web UI or Fabric Agents Desktop, create a workspace, and verify again.",
			),
		);

		renderPicker();

		fireEvent.click(
			await screen.findByRole("button", {
				name: /Personal Fabric Agents Remote Server/i,
			}),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Verify and connect" }),
		);

		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(
				"This Fabric Agents server is reachable, but it has no workspace yet.",
			),
		);
	});
});

const secureRandomError =
	"Cannot generate a server secret because secure randomness is unavailable. Enter a server secret manually.";

describe("generateServerSecret", () => {
	it("encodes 24 bytes from Web Crypto as 48 lowercase hex digits", () => {
		const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(0x0a));
		vi.stubGlobal("crypto", { getRandomValues });

		expect(generateServerSecret()).toBe(`fab_srv_${"0a".repeat(24)}`);
		expect(getRandomValues).toHaveBeenCalledExactlyOnceWith(
			expect.any(Uint8Array),
		);
	});

	it.each([
		["missing crypto", undefined],
		["missing getRandomValues", {}],
		["non-callable getRandomValues", { getRandomValues: true }],
	])("throws without using Math.random for %s", (_, crypto) => {
		vi.stubGlobal("crypto", crypto);
		const random = vi.spyOn(Math, "random");

		expect.soft(generateServerSecret).toThrow(new Error(secureRandomError));
		expect(random).not.toHaveBeenCalled();
	});
});

it.each([
	/Personal Fabric Agents Remote Server/i,
	/Organization Fabric Agents Remote Server/i,
	"Generate token",
	"Copy setup command",
])("surfaces a generation failure from %s", (name) => {
	vi.stubGlobal("crypto", {});
	const writeText = vi.fn();
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
	renderPicker();

	fireEvent.click(screen.getByRole("button", { name }));

	expect(f.toastError).toHaveBeenCalledExactlyOnceWith(secureRandomError);
	expect(writeText).not.toHaveBeenCalled();
	const connect = screen.getByRole("button", { name: "Verify and connect" });
	expect(connect).toBeDisabled();
	fireEvent.click(connect);
	expect(f.connect).not.toHaveBeenCalled();
});
