/**
 * Social OAuth providers, extracted to a standalone module so the config can be
 * asserted in unit tests without importing the full `betterAuth()` instance.
 *
 * `prompt: "select_account"` forces Google's account chooser, letting a user who
 * is already signed in (e.g. accepting an invite under a different identity) pick
 * the correct Google account instead of being silently re-authenticated. GitHub
 * has no equivalent (it reuses the active github.com session) and is left as-is.
 */
export const socialProviders = {
	google: {
		clientId: process.env.GOOGLE_CLIENT_ID as string,
		clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
		scope: ["email", "profile"],
		prompt: "select_account" as const,
		// `POST /sign-in/social` with a client-supplied `idToken` skips the
		// OAuth redirect and mints a session directly
		// (`better-auth/dist/api/routes/sign-in.mjs`). That path is matched
		// by neither Better Auth's own 2FA hook (which only intercepts
		// /sign-in/{email,username,phone-number}) nor auth.ts's replica
		// (/magic-link/verify, /callback/*, /oauth2/callback/*) — so a
		// `twoFactorEnabled` user signing in this way would skip the TOTP
		// challenge entirely. Nothing in this repo currently sends an
		// `idToken` to `signIn.social`, but disabling the branch outright
		// removes the bypass instead of relying on that staying true.
		disableIdTokenSignIn: true,
	},
	github: {
		clientId: process.env.FABRIC_GITHUB_CLIENT_ID as string,
		clientSecret: process.env.FABRIC_GITHUB_CLIENT_SECRET as string,
		scope: ["user:email"],
	},
};
