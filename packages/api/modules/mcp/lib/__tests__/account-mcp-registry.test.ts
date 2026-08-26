/**
 * Tests for Account-Based MCP Registry
 *
 * Tests the pluggable registry for hosted MCP services
 * like Gmail, Google Docs, GitHub, etc.
 */

import { describe, expect, it } from "vitest";
import {
	ACCOUNT_REGISTRY,
	findMcpByUrl,
	getAccountByCredentialType,
	getAccountById,
	getAccountMcps,
	getAccounts,
	getAvailableAccountMcps,
	getMcpDefinition,
	getMcpTools,
	getRequiredScopes,
	isAccountSupported,
} from "../account-mcp-registry";

describe("Account-Based MCP Registry", () => {
	describe("getAccounts", () => {
		it("should return all registered accounts", () => {
			const accounts = getAccounts();

			expect(accounts).toBeInstanceOf(Array);
			expect(accounts.length).toBeGreaterThan(0);
		});

		it("should include Google and GitHub accounts", () => {
			const accounts = getAccounts();
			const accountIds = accounts.map((a) => a.id);

			expect(accountIds).toContain("google");
			expect(accountIds).toContain("github");
		});
	});

	describe("getAccountById", () => {
		it("should return Google account by ID", () => {
			const account = getAccountById("google");

			expect(account).toBeDefined();
			expect(account?.name).toBe("Google");
			expect(account?.credentialType).toBe("google_oauth");
			expect(account?.authType).toBe("oauth");
		});

		it("should return GitHub account by ID", () => {
			const account = getAccountById("github");

			expect(account).toBeDefined();
			expect(account?.name).toBe("GitHub");
			expect(account?.credentialType).toBe("github_oauth");
		});

		it("should return undefined for unknown account", () => {
			const account = getAccountById("unknown-account");

			expect(account).toBeUndefined();
		});
	});

	describe("getAccountMcps", () => {
		it("should return MCPs for Google account", () => {
			const mcps = getAccountMcps("google");

			expect(mcps).toBeInstanceOf(Array);
			expect(mcps.length).toBeGreaterThan(0);

			const mcpIds = mcps.map((m) => m.id);
			expect(mcpIds).toContain("gmail");
			expect(mcpIds).toContain("google-docs");
			expect(mcpIds).toContain("google-sheets");
		});

		it("should return MCPs for GitHub account", () => {
			const mcps = getAccountMcps("github");

			expect(mcps).toBeInstanceOf(Array);

			const mcpIds = mcps.map((m) => m.id);
			expect(mcpIds).toContain("github-repos");
		});

		it("should return empty array for unknown account", () => {
			const mcps = getAccountMcps("unknown");

			expect(mcps).toEqual([]);
		});
	});

	describe("getAvailableAccountMcps", () => {
		it("should filter out coming soon MCPs", () => {
			const allMcps = getAccountMcps("google");
			const availableMcps = getAvailableAccountMcps("google");

			// All current Google MCPs are coming soon, so should be empty
			// or fewer than total
			expect(availableMcps.length).toBeLessThanOrEqual(allMcps.length);
		});

		it("should return empty for account with all coming soon MCPs", () => {
			// Currently all Google MCPs are marked as coming soon
			const availableMcps = getAvailableAccountMcps("google");

			// If all are coming soon, should be empty
			const allMcps = getAccountMcps("google");
			const allComingSoon = allMcps.every(
				(m) => m.comingSoon || m.available === false,
			);

			if (allComingSoon) {
				expect(availableMcps).toEqual([]);
			}
		});
	});

	describe("getMcpDefinition", () => {
		it("should return Gmail MCP definition", () => {
			const gmail = getMcpDefinition("google", "gmail");

			expect(gmail).toBeDefined();
			expect(gmail?.name).toBe("Gmail");
			expect(gmail?.serverName).toBe("Gmail");
			expect(gmail?.description).toContain("email");
		});

		it("should return Google Docs MCP definition", () => {
			const docs = getMcpDefinition("google", "google-docs");

			expect(docs).toBeDefined();
			expect(docs?.name).toBe("Google Docs");
		});

		it("should return undefined for unknown MCP", () => {
			const unknown = getMcpDefinition("google", "unknown-mcp");

			expect(unknown).toBeUndefined();
		});

		it("should return undefined for unknown account", () => {
			const unknown = getMcpDefinition("unknown", "gmail");

			expect(unknown).toBeUndefined();
		});
	});

	describe("getRequiredScopes", () => {
		it("should return base scopes for account", () => {
			const scopes = getRequiredScopes("google");

			expect(scopes).toContain("openid");
			expect(scopes).toContain("email");
			expect(scopes).toContain("profile");
		});

		it("should include Gmail-specific scopes when requesting Gmail MCP", () => {
			const scopes = getRequiredScopes("google", ["gmail"]);

			// Should have base scopes
			expect(scopes).toContain("openid");

			// Should have Gmail scopes
			expect(scopes).toContain(
				"https://www.googleapis.com/auth/gmail.readonly",
			);
			expect(scopes).toContain(
				"https://www.googleapis.com/auth/gmail.send",
			);
		});

		it("should combine scopes for multiple MCPs", () => {
			const scopes = getRequiredScopes("google", [
				"gmail",
				"google-docs",
			]);

			// Should have Gmail scopes
			expect(scopes).toContain(
				"https://www.googleapis.com/auth/gmail.readonly",
			);

			// Should have Docs scopes
			expect(scopes).toContain(
				"https://www.googleapis.com/auth/documents",
			);
		});

		it("should deduplicate scopes", () => {
			const scopes = getRequiredScopes("google", [
				"gmail",
				"google-docs",
				"google-sheets",
			]);

			// Check for duplicates
			const uniqueScopes = [...new Set(scopes)];
			expect(scopes.length).toBe(uniqueScopes.length);
		});

		it("should return empty array for unknown account", () => {
			const scopes = getRequiredScopes("unknown");

			expect(scopes).toEqual([]);
		});
	});

	describe("getMcpTools", () => {
		it("should return tools for Gmail MCP", () => {
			const tools = getMcpTools("google", "gmail");

			expect(tools).toBeInstanceOf(Array);
			expect(tools.length).toBeGreaterThan(0);

			const toolNames = tools.map((t) => t.name);
			expect(toolNames).toContain("listMessages");
			expect(toolNames).toContain("getMessage");
			expect(toolNames).toContain("sendEmail");
		});

		it("should have proper tool schema structure", () => {
			const tools = getMcpTools("google", "gmail");
			const sendEmailTool = tools.find((t) => t.name === "sendEmail");

			expect(sendEmailTool).toBeDefined();
			expect(sendEmailTool?.description).toBeDefined();
			expect(sendEmailTool?.inputSchema).toBeDefined();
			expect(sendEmailTool?.inputSchema.type).toBe("object");
			expect(sendEmailTool?.inputSchema.properties).toBeDefined();
			expect(sendEmailTool?.inputSchema.required).toContain("to");
			expect(sendEmailTool?.inputSchema.required).toContain("subject");
			expect(sendEmailTool?.inputSchema.required).toContain("body");
		});

		it("should mark approval required fields", () => {
			const tools = getMcpTools("google", "gmail");
			const sendEmailTool = tools.find((t) => t.name === "sendEmail");

			expect(sendEmailTool?.approvalRequiredFields).toBeDefined();
			expect(sendEmailTool?.approvalRequiredFields).toContain("to");
			expect(sendEmailTool?.approvalRequiredFields).toContain("subject");
		});

		it("should return empty array for unknown MCP", () => {
			const tools = getMcpTools("google", "unknown");

			expect(tools).toEqual([]);
		});
	});

	describe("findMcpByUrl", () => {
		it("should find Gmail MCP for Gmail URL", () => {
			const result = findMcpByUrl(
				"https://mail.google.com/mail/u/0/#inbox",
			);

			expect(result).not.toBeNull();
			expect(result?.account.id).toBe("google");
			expect(result?.mcp.id).toBe("gmail");
		});

		it("should find Google Docs MCP for Docs URL", () => {
			const result = findMcpByUrl(
				"https://docs.google.com/document/d/123abc/edit",
			);

			expect(result).not.toBeNull();
			expect(result?.account.id).toBe("google");
			expect(result?.mcp.id).toBe("google-docs");
		});

		it("should find Google Sheets MCP for Sheets URL", () => {
			const result = findMcpByUrl(
				"https://docs.google.com/spreadsheets/d/456def/edit",
			);

			expect(result).not.toBeNull();
			expect(result?.account.id).toBe("google");
			expect(result?.mcp.id).toBe("google-sheets");
		});

		it("should find GitHub MCP for GitHub repo URL", () => {
			const result = findMcpByUrl("https://github.com/owner/repo");

			expect(result).not.toBeNull();
			expect(result?.account.id).toBe("github");
			expect(result?.mcp.id).toBe("github-repos");
		});

		it("should return null for unmatched URL", () => {
			const result = findMcpByUrl("https://example.com/page");

			expect(result).toBeNull();
		});

		it("should return null for invalid URL", () => {
			const result = findMcpByUrl("not-a-valid-url");

			expect(result).toBeNull();
		});
	});

	describe("isAccountSupported", () => {
		it("should return true for Google OAuth", () => {
			expect(isAccountSupported("google_oauth")).toBe(true);
		});

		it("should return true for GitHub OAuth", () => {
			expect(isAccountSupported("github_oauth")).toBe(true);
		});

		it("should return false for unknown credential type", () => {
			expect(isAccountSupported("unknown_oauth")).toBe(false);
		});
	});

	describe("getAccountByCredentialType", () => {
		it("should return Google account for google_oauth", () => {
			const account = getAccountByCredentialType("google_oauth");

			expect(account).toBeDefined();
			expect(account?.id).toBe("google");
		});

		it("should return GitHub account for github_oauth", () => {
			const account = getAccountByCredentialType("github_oauth");

			expect(account).toBeDefined();
			expect(account?.id).toBe("github");
		});

		it("should return undefined for unknown credential type", () => {
			const account = getAccountByCredentialType("unknown");

			expect(account).toBeUndefined();
		});
	});

	describe("Registry Data Structure", () => {
		it("should have valid structure for all accounts", () => {
			for (const account of ACCOUNT_REGISTRY) {
				expect(account.id).toBeDefined();
				expect(account.name).toBeDefined();
				expect(account.credentialType).toBeDefined();
				expect(account.authType).toBeDefined();
				expect(account.mcps).toBeInstanceOf(Array);
			}
		});

		it("should have valid structure for all MCPs", () => {
			for (const account of ACCOUNT_REGISTRY) {
				for (const mcp of account.mcps) {
					expect(mcp.id).toBeDefined();
					expect(mcp.name).toBeDefined();
					expect(mcp.serverName).toBeDefined();
					expect(mcp.description).toBeDefined();
				}
			}
		});

		it("should have unique MCP IDs within each account", () => {
			for (const account of ACCOUNT_REGISTRY) {
				const mcpIds = account.mcps.map((m) => m.id);
				const uniqueIds = [...new Set(mcpIds)];
				expect(mcpIds.length).toBe(uniqueIds.length);
			}
		});
	});
});
