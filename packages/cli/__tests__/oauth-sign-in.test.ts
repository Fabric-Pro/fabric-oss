/**
 * The one step that signs a person in through the browser (Fizzy #2878): the
 * tokens it gets are kept only if the sign-in server that granted them is the
 * deployment's own, and are neither stored nor used for a request otherwise.
 *
 * The browser flow, the stored configuration and the SDK client are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signInWithBrowser } from "../src/lib/oauth/sign-in.js";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		loginWithBrowser: vi.fn(),
		getOAuth: vi.fn(),
		getRegisteredClient: vi.fn(),
		saveOAuth: vi.fn(),
		revokeOAuthSession: vi.fn(async () => true),
		whoami: vi.fn(),
	},
}));

vi.mock("@fabricorg/sdk", async (importOriginal) => ({
	...(await importOriginal<typeof import("@fabricorg/sdk")>()),
	FabricClient: class {
		auth = { whoami: mocks.whoami };
	},
}));

vi.mock("../src/lib/config.js", () => ({
	getOAuth: mocks.getOAuth,
	getRegisteredClient: mocks.getRegisteredClient,
	saveOAuth: mocks.saveOAuth,
}));

vi.mock("../src/lib/oauth/flow.js", () => ({
	loginWithBrowser: mocks.loginWithBrowser,
}));

vi.mock("../src/lib/oauth/browser.js", () => ({
	openBrowser: vi.fn(),
}));

vi.mock("../src/lib/oauth/session.js", () => ({
	revokeOAuthSession: mocks.revokeOAuthSession,
}));

const ORIGIN = "https://deploy.example.com";

function credentials(issuer: string) {
	return {
		issuer,
		clientId: "client-example",
		redirectUri: "http://127.0.0.1:49152/callback",
		tokenEndpoint: `${issuer}/token`,
		accessToken: "fat_access",
		refreshToken: "frt_refresh",
		expiresAt: 1_900_000_000_000,
	};
}

function signIn(project?: string) {
	return signInWithBrowser({
		baseUrl: ORIGIN,
		origin: ORIGIN,
		explicit: true,
		announce: () => undefined,
		...(project === undefined ? {} : { project }),
	});
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	mocks.revokeOAuthSession.mockResolvedValue(true);
	mocks.getOAuth.mockReturnValue(undefined);
	mocks.getRegisteredClient.mockReturnValue(undefined);
	mocks.whoami.mockResolvedValue({
		user: { name: "Dev", email: "dev@example.com" },
	});
});

describe("a browser sign-in", () => {
	it("is kept when the sign-in server is the deployment's own", async () => {
		mocks.loginWithBrowser.mockResolvedValue(
			credentials(`${ORIGIN}/api/auth`),
		);

		const who = await signIn();

		expect(who).toEqual({ name: "Dev", email: "dev@example.com" });
		expect(mocks.saveOAuth).toHaveBeenCalledTimes(1);
	});

	it.each([
		["another origin", "https://attacker.example/api/auth"],
		["another port of this host", `${ORIGIN}:8443/api/auth`],
		["another scheme", "http://deploy.example.com/api/auth"],
		["a sub-domain", "https://login.deploy.example.com/api/auth"],
		["something that is not a URL", "deploy.example.com"],
		["nothing", ""],
	])(
		"is refused, with a fixed line, when it was issued by %s",
		async (_label, issuer) => {
			mocks.loginWithBrowser.mockResolvedValue(credentials(issuer));

			const attempt = signIn();

			await expect(attempt).rejects.toThrow(
				`The sign-in for ${ORIGIN} was issued by another site, so nothing was kept.`,
			);
			expect(mocks.whoami).not.toHaveBeenCalled();
			expect(mocks.saveOAuth).not.toHaveBeenCalled();
			expect(mocks.revokeOAuthSession).not.toHaveBeenCalled();
		},
	);

	it("never names the issuer in what it says", async () => {
		mocks.loginWithBrowser.mockResolvedValue(
			credentials("https://attacker.example/api/auth"),
		);

		const error = await signIn().catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain("attacker");
	});

	it("is not kept when the deployment will not accept the tokens it issued", async () => {
		mocks.loginWithBrowser.mockResolvedValue(credentials(ORIGIN));
		mocks.whoami.mockRejectedValue(new Error("401"));

		const attempt = signIn();

		await expect(attempt).rejects.toThrow(
			`Signed in, but ${ORIGIN} did not accept the new credentials.`,
		);
		expect(mocks.saveOAuth).not.toHaveBeenCalled();
	});
});

describe("a browser sign-in for one project", () => {
	const PROJECT = "project-example-one";

	beforeEach(() => {
		mocks.whoami.mockResolvedValue({
			user: { name: "Dev", email: "dev@example.com" },
			projectContext: PROJECT,
		});
	});

	it("asks for that project and keeps the tokens as that project's, leaving the deployment's own sign-in alone", async () => {
		mocks.loginWithBrowser.mockResolvedValue(credentials(ORIGIN));

		await signIn(PROJECT);

		expect(mocks.loginWithBrowser).toHaveBeenCalledWith(
			expect.objectContaining({ baseUrl: ORIGIN, project: PROJECT }),
		);
		expect(mocks.saveOAuth).toHaveBeenCalledOnce();
		expect(mocks.saveOAuth).toHaveBeenCalledWith(
			credentials(ORIGIN),
			expect.objectContaining({ projectId: PROJECT }),
		);
		expect(mocks.revokeOAuthSession).not.toHaveBeenCalled();
	});

	it("revokes only that project's previous sign-in, and never another project's or the deployment's", async () => {
		const previous = {
			...credentials(ORIGIN),
			refreshToken: "frt_previous",
		};
		mocks.getOAuth.mockImplementation((origin: string, project?: string) =>
			origin === ORIGIN && project === PROJECT ? previous : undefined,
		);
		mocks.loginWithBrowser.mockResolvedValue(credentials(ORIGIN));

		await signIn(PROJECT);

		expect(mocks.getOAuth).toHaveBeenCalledWith(ORIGIN, PROJECT);
		expect(mocks.revokeOAuthSession).toHaveBeenCalledOnce();
		expect(mocks.revokeOAuthSession).toHaveBeenCalledWith(previous);
	});

	it("does not revoke the deployment's own sign-in when it signs in for a project", async () => {
		const organizationWide = {
			...credentials(ORIGIN),
			refreshToken: "frt_organization",
		};
		mocks.getOAuth.mockImplementation(
			(_origin: string, project?: string) =>
				project === undefined ? organizationWide : undefined,
		);
		mocks.loginWithBrowser.mockResolvedValue(credentials(ORIGIN));

		await signIn(PROJECT);

		expect(mocks.revokeOAuthSession).not.toHaveBeenCalled();
	});

	it("takes the client registration of any sign-in the deployment has, so the person keeps one Fabric CLI", async () => {
		const registered = credentials(ORIGIN);
		mocks.getRegisteredClient.mockReturnValue(registered);
		mocks.loginWithBrowser.mockResolvedValue(credentials(ORIGIN));

		await signIn(PROJECT);

		expect(mocks.getRegisteredClient).toHaveBeenCalledWith(ORIGIN, PROJECT);
		expect(mocks.loginWithBrowser).toHaveBeenCalledWith(
			expect.objectContaining({ previous: registered }),
		);
	});

	it.each([
		["no project", undefined],
		["another project", "project-example-two"],
	])(
		"is not kept when the deployment says it reaches %s",
		async (_label, projectContext) => {
			mocks.whoami.mockResolvedValue({
				user: { name: "Dev", email: "dev@example.com" },
				...(projectContext === undefined ? {} : { projectContext }),
			});
			mocks.loginWithBrowser.mockResolvedValue(credentials(ORIGIN));

			await expect(signIn(PROJECT)).rejects.toThrow(
				`Signed in, but ${ORIGIN} did not accept the new credentials.`,
			);

			expect(mocks.saveOAuth).not.toHaveBeenCalled();
		},
	);

	it.each([
		["no project", undefined],
		["another project", "project-example-two"],
	])(
		"ends the sign-in it did not keep, and only that one, when the deployment says it reaches %s",
		async (_label, projectContext) => {
			const previous = {
				...credentials(ORIGIN),
				accessToken: "fat_previous",
				refreshToken: "frt_previous",
			};
			mocks.getOAuth.mockReturnValue(previous);
			mocks.whoami.mockResolvedValue({
				user: { name: "Dev", email: "dev@example.com" },
				...(projectContext === undefined ? {} : { projectContext }),
			});
			mocks.loginWithBrowser.mockResolvedValue(credentials(ORIGIN));

			await expect(signIn(PROJECT)).rejects.toThrow(
				`Signed in, but ${ORIGIN} did not accept the new credentials.`,
			);

			expect(mocks.revokeOAuthSession).toHaveBeenCalledOnce();
			expect(mocks.revokeOAuthSession).toHaveBeenCalledWith(
				credentials(ORIGIN),
			);
		},
	);

	it("still refuses, with the same line, when ending the unkept sign-in fails", async () => {
		mocks.whoami.mockResolvedValue({
			user: { name: "Dev", email: "dev@example.com" },
		});
		mocks.revokeOAuthSession.mockResolvedValue(false);
		mocks.loginWithBrowser.mockResolvedValue(credentials(ORIGIN));

		await expect(signIn(PROJECT)).rejects.toThrow(
			`Signed in, but ${ORIGIN} did not accept the new credentials.`,
		);

		expect(mocks.saveOAuth).not.toHaveBeenCalled();
	});

	it("revokes nothing when the deployment would not answer at all", async () => {
		mocks.whoami.mockRejectedValue(new Error("down"));
		mocks.loginWithBrowser.mockResolvedValue(credentials(ORIGIN));

		await expect(signIn(PROJECT)).rejects.toThrow(
			`Signed in, but ${ORIGIN} did not accept the new credentials.`,
		);

		expect(mocks.revokeOAuthSession).not.toHaveBeenCalled();
	});

	it("asks for no project when the sign-in is for the organization", async () => {
		mocks.loginWithBrowser.mockResolvedValue(credentials(ORIGIN));
		mocks.whoami.mockResolvedValue({
			user: { name: "Dev", email: "dev@example.com" },
		});

		await signIn();

		expect(mocks.loginWithBrowser).toHaveBeenCalledWith(
			expect.objectContaining({ project: undefined }),
		);
		expect(mocks.saveOAuth).toHaveBeenCalledWith(
			credentials(ORIGIN),
			expect.not.objectContaining({ projectId: expect.anything() }),
		);
	});
});
