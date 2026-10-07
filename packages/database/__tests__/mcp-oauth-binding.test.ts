/**
 * The client authentication method is a per-client value recorded at
 * registration, not a global default: a dynamically registered client keeps
 * what the AS said, or else what Fabric requested (RFC 7591's default,
 * `client_secret_basic`); only Fabric's own and hand-entered clients use
 * `client_secret_post`.
 */

import { describe, expect, it } from "vitest";
import {
	allowlistDcrClientMetadata,
	explicitClientMetadata,
	resolveMcpClientAuthMethod,
} from "../prisma/queries/lib/mcp-oauth-binding";

describe("allowlistDcrClientMetadata — the effective auth method", () => {
	it("records the method Fabric requested when the response names none", () => {
		expect(
			allowlistDcrClientMetadata(
				{ client_id: "c", client_secret: "s" },
				"https://as.example.com",
				"client_secret_basic",
			),
		).toEqual({
			token_endpoint_auth_method: "client_secret_basic",
			issuer: "https://as.example.com",
		});
	});

	it("keeps the method the AS registered", () => {
		expect(
			allowlistDcrClientMetadata(
				{ token_endpoint_auth_method: "none" },
				null,
				"client_secret_basic",
			).token_endpoint_auth_method,
		).toBe("none");
	});

	it("ignores a method Fabric does not support", () => {
		expect(
			allowlistDcrClientMetadata(
				{ token_endpoint_auth_method: "private_key_jwt" },
				null,
				"client_secret_basic",
			).token_endpoint_auth_method,
		).toBe("client_secret_basic");
	});
});

describe("resolveMcpClientAuthMethod", () => {
	it("uses the stored per-client method", () => {
		expect(
			resolveMcpClientAuthMethod({
				dcrClientMetadata: explicitClientMetadata(),
				dcrRegisteredAt: new Date(),
			}),
		).toBe("client_secret_post");
	});

	it("treats a dynamically registered client stored without one as client_secret_basic", () => {
		expect(
			resolveMcpClientAuthMethod({
				dcrClientMetadata: { client_id_issued_at: 1 },
				dcrRegisteredAt: new Date(),
				encryptedOauthClientSecret: "enc",
			}),
		).toBe("client_secret_basic");
	});

	it("keeps client_secret_post for a legacy pre-registered or hand-entered client", () => {
		expect(
			resolveMcpClientAuthMethod({
				dcrClientMetadata: null,
				dcrRegisteredAt: null,
				encryptedOauthClientSecret: "enc",
			}),
		).toBe("client_secret_post");
	});
});
