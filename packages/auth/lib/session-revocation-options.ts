import type { BetterAuthOptions } from "better-auth";

/** Security invariants shared by every password-reset and session-read path. */
export const sessionRevocationOptions = {
	session: {
		cookieCache: {
			enabled: false,
		},
	},
	emailAndPassword: {
		enabled: true,
		revokeSessionsOnPasswordReset: true,
	},
} as const satisfies {
	session: NonNullable<BetterAuthOptions["session"]>;
	emailAndPassword: NonNullable<BetterAuthOptions["emailAndPassword"]>;
};
