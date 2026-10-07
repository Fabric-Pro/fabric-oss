import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { enable, verifyTotp, toastError } = vi.hoisted(() => ({
	enable: vi.fn(),
	verifyTotp: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("@repo/auth/client", () => ({
	authClient: { twoFactor: { enable, verifyTotp } },
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { twoFactorEnabled: false },
		reloadSession: vi.fn(),
	}),
}));
vi.mock("@saas/auth/hooks/errors-messages", () => ({
	useAuthErrorMessages: () => ({
		getAuthErrorMessage: (code: string) => code,
	}),
}));
vi.mock("@saas/auth/lib/api", () => ({
	useUserAccountsQuery: () => ({ data: [{ providerId: "credential" }] }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
// Backup code management has its own server queries; enrollment renders it
// only after verification, beyond the boundary covered here.
vi.mock("@saas/settings/components/BackupCodesPanel", () => ({
	BackupCodesPanel: () => null,
}));

import { TwoFactorBlock } from "@saas/settings/components/TwoFactorBlock";

const totpURI = "otpauth://totp/example?secret=EXAMPLESECRET";

async function submitPassword() {
	fireEvent.click(
		screen.getByRole("button", {
			name: "settings.account.security.twoFactor.enable",
		}),
	);
	fireEvent.change(
		document.querySelector('input[type="password"]') as HTMLInputElement,
		{
			target: { value: "example-password" },
		},
	);
	fireEvent.click(
		screen.getByRole("button", { name: "common.actions.continue" }),
	);
	await waitFor(() => expect(enable).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(cleanup);

describe("two-factor authenticator enrollment", () => {
	it("requests TOTP and shows its setup with backup codes after verification", async () => {
		enable.mockResolvedValue({
			data: { method: "totp", totpURI, backupCodes: ["aaaaa-bbbbb"] },
			error: null,
		});
		verifyTotp.mockResolvedValue({ error: null });
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<TwoFactorBlock />
			</QueryClientProvider>,
		);
		await submitPassword();
		expect(enable).toHaveBeenCalledWith({
			password: "example-password",
			method: "totp",
		});
		await screen.findByText("EXAMPLESECRET");
		expect(client.getQueryData(["backupCodesStatus"])).toEqual({
			remaining: 1,
			total: 10,
		});
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "123456" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "common.actions.verify" }),
		);
		await screen.findByText("aaaaa-bbbbb");
	});

	it.each([{ method: "otp" }, null])(
		"keeps the password step on an unexpected enrollment result %j",
		async (data) => {
			enable.mockResolvedValue({ data, error: null });
			const client = new QueryClient();
			render(
				<QueryClientProvider client={client}>
					<TwoFactorBlock />
				</QueryClientProvider>,
			);
			await submitPassword();
			await waitFor(() => expect(toastError).toHaveBeenCalled());
			expect(
				screen.getByRole("heading", {
					name: "settings.account.security.twoFactor.dialog.password.title",
				}),
			).toBeInTheDocument();
			expect(
				screen.queryByText(
					"settings.account.security.twoFactor.dialog.totpUrl.title",
				),
			).not.toBeInTheDocument();
			expect(client.getQueryData(["backupCodesStatus"])).toBeUndefined();
		},
	);
});
