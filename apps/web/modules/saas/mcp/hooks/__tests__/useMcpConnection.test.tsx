import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMcpConnection } from "../useMcpConnection";

// Mock toast
vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock orpc client
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		mcp: {
			configs: {
				toggle: vi.fn(),
			},
			oauth: {
				refresh: vi.fn(),
				start: vi.fn(),
			},
		},
	},
}));

describe("useMcpConnection", () => {
	let queryClient: QueryClient;
	let wrapper: ({ children }: { children: ReactNode }) => JSX.Element;

	beforeEach(() => {
		queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});

		wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>
				{children}
			</QueryClientProvider>
		);

		// Clear all mocks
		vi.clearAllMocks();

		// Reset fetch mock
		global.fetch = vi.fn();
	});

	describe("checkOAuthStatuses", () => {
		it("should fetch OAuth status for OAuth2 configs", async () => {
			const mockConfigs = [
				{
					id: "config-1",
					authType: "OAUTH2",
					baseUrl: "https://example.com",
				},
				{
					id: "config-2",
					authType: "API_KEY",
					baseUrl: "https://api.example.com",
				},
			];

			const mockStatus = {
				data: {
					authenticated: true,
					tokenExpired: false,
					refreshTokenExpired: false,
					hasRefreshToken: true,
					tokenExpiresAt: "2025-12-31T23:59:59Z",
				},
			};

			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockStatus,
			});

			const { result } = renderHook(() => useMcpConnection(), {
				wrapper,
			});

			const statuses =
				await result.current.checkOAuthStatuses(mockConfigs);

			expect(global.fetch).toHaveBeenCalledTimes(1);
			expect(global.fetch).toHaveBeenCalledWith(
				"/api/mcp/oauth/status/config-1?organizationId=",
			);
			expect(statuses["config-1"]).toEqual({
				authenticated: true,
				tokenExpired: false,
				refreshTokenExpired: false,
				hasRefreshToken: true,
				expiresAt: new Date("2025-12-31T23:59:59Z"),
			});
			expect(statuses["config-2"]).toBeUndefined();
		});

		it("should handle fetch errors gracefully", async () => {
			const consoleSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});

			const mockConfigs = [
				{
					id: "config-1",
					authType: "OAUTH2",
					baseUrl: "https://example.com",
				},
			];

			(global.fetch as any).mockRejectedValueOnce(
				new Error("Network error"),
			);

			const { result } = renderHook(() => useMcpConnection(), {
				wrapper,
			});

			const statuses =
				await result.current.checkOAuthStatuses(mockConfigs);

			expect(consoleSpy).toHaveBeenCalled();
			expect(statuses).toEqual({});

			consoleSpy.mockRestore();
		});

		it("should handle non-OK responses", async () => {
			const mockConfigs = [
				{
					id: "config-1",
					authType: "OAUTH2",
					baseUrl: "https://example.com",
				},
			];

			(global.fetch as any).mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			const { result } = renderHook(() => useMcpConnection(), {
				wrapper,
			});

			const statuses =
				await result.current.checkOAuthStatuses(mockConfigs);

			expect(statuses).toEqual({});
		});
	});

	describe("testMutation", () => {
		it("should successfully test connection and show success toast", async () => {
			const mockConfig = {
				id: "config-1",
				baseUrl: "https://example.com/mcp",
				transport: "HTTP",
				authType: "API_KEY",
			};

			const mockResponse = {
				success: true,
				details: {
					serverInfo: {
						name: "Test MCP Server",
						version: "1.0.0",
					},
					protocolVersion: "2025-03-26",
					responseTime: 123,
				},
			};

			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockResponse,
			});

			const { result } = renderHook(() => useMcpConnection(), {
				wrapper,
			});

			result.current.testMutation.mutate(mockConfig);

			await waitFor(() => {
				expect(result.current.testMutation.isSuccess).toBe(true);
			});

			expect(global.fetch).toHaveBeenCalledWith(
				"/api/mcp/test-connection",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						configId: "config-1",
						baseUrl: "https://example.com/mcp",
						transport: "HTTP",
						authType: "API_KEY",
					}),
				},
			);
		});

		it("should handle test connection failure", async () => {
			const mockConfig = {
				id: "config-1",
				baseUrl: "https://example.com/mcp",
				transport: "HTTP",
				authType: "API_KEY",
			};

			(global.fetch as any).mockResolvedValueOnce({
				ok: false,
				json: async () => ({
					message: "Connection timeout",
				}),
			});

			const { result } = renderHook(() => useMcpConnection(), {
				wrapper,
			});

			result.current.testMutation.mutate(mockConfig);

			await waitFor(() => {
				expect(result.current.testMutation.isError).toBe(true);
			});
		});

		it("should use default URL from mcpServer if baseUrl not provided", async () => {
			const mockConfig = {
				id: "config-1",
				transport: "HTTP",
				authType: "NONE",
				mcpServer: {
					defaultUrl: "https://default.example.com/mcp",
				},
			};

			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => ({ success: true }),
			});

			const { result } = renderHook(() => useMcpConnection(), {
				wrapper,
			});

			result.current.testMutation.mutate(mockConfig);

			await waitFor(() => {
				expect(result.current.testMutation.isSuccess).toBe(true);
			});

			expect(global.fetch).toHaveBeenCalledWith(
				"/api/mcp/test-connection",
				expect.objectContaining({
					body: expect.stringContaining(
						"https://default.example.com/mcp",
					),
				}),
			);
		});
	});

	describe("refreshMutation", () => {
		it("should successfully refresh token", async () => {
			const { orpcClient } = await import("@shared/lib/orpc-client");
			const mockConfig = {
				id: "config-1",
				authType: "OAUTH2",
			};

			// Mock the oRPC refresh call
			(orpcClient.mcp.oauth.refresh as any).mockResolvedValueOnce({
				success: true,
			});

			// Mock the OAuth status check that happens after refresh
			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: {
						authenticated: true,
						tokenExpired: false,
						refreshTokenExpired: false,
						hasRefreshToken: true,
						tokenExpiresAt: "2025-12-31T23:59:59Z",
					},
				}),
			});

			const { result } = renderHook(() => useMcpConnection(), {
				wrapper,
			});

			result.current.refreshMutation.mutate(mockConfig);

			await waitFor(() => {
				expect(result.current.refreshMutation.isSuccess).toBe(true);
			});

			expect(orpcClient.mcp.oauth.refresh).toHaveBeenCalledWith({
				configId: "config-1",
			});
		});

		it("should handle refresh failure", async () => {
			const { orpcClient } = await import("@shared/lib/orpc-client");
			const mockConfig = {
				id: "config-1",
				authType: "OAUTH2",
			};

			(orpcClient.mcp.oauth.refresh as any).mockRejectedValueOnce(
				new Error("Refresh failed"),
			);

			const { result } = renderHook(() => useMcpConnection(), {
				wrapper,
			});

			result.current.refreshMutation.mutate(mockConfig);

			await waitFor(() => {
				expect(result.current.refreshMutation.isError).toBe(true);
			});
		});

		it("should treat a refused refresh as an error, not a success", async () => {
			const { toast } = await import("sonner");
			const { orpcClient } = await import("@shared/lib/orpc-client");
			const mockConfig = {
				id: "config-1",
				authType: "OAUTH2",
			};

			// A refusal is an HTTP-successful response carrying
			// `{ success: false }`, so the oRPC call resolves normally. Without
			// the mutationFn check the user is told the token was refreshed at
			// the exact moment the server declined to refresh it.
			(orpcClient.mcp.oauth.refresh as any).mockResolvedValueOnce({
				success: false,
			});

			const { result } = renderHook(() => useMcpConnection(), {
				wrapper,
			});

			result.current.refreshMutation.mutate(mockConfig);

			await waitFor(() => {
				expect(result.current.refreshMutation.isError).toBe(true);
			});

			expect(toast.success).not.toHaveBeenCalled();
			expect(toast.error).toHaveBeenCalledWith(
				"Failed to refresh token",
				expect.objectContaining({
					description: expect.stringContaining("re-authenticate"),
				}),
			);
			// The error path must clear the per-config spinner the same way the
			// success path does.
			expect(result.current.loadingStates["config-1"]?.refresh).toBe(
				false,
			);
		});
	});

	describe("toggleMutation", () => {
		it("should successfully toggle configuration", async () => {
			const { orpcClient } = await import("@shared/lib/orpc-client");
			const mockConfig = {
				id: "config-1",
			};

			(orpcClient.mcp.configs.toggle as any).mockResolvedValueOnce({
				success: true,
			});

			const { result } = renderHook(() => useMcpConnection(), {
				wrapper,
			});

			result.current.toggleMutation.mutate({
				config: mockConfig,
				enabled: false,
			});

			await waitFor(() => {
				expect(result.current.toggleMutation.isSuccess).toBe(true);
			});

			expect(orpcClient.mcp.configs.toggle).toHaveBeenCalledWith({
				id: "config-1",
				enabled: false,
				// XOR pattern: explicit null means personal context.
				organizationId: null,
			});
		});

		it("should handle toggle failure", async () => {
			const { orpcClient } = await import("@shared/lib/orpc-client");
			const mockConfig = {
				id: "config-1",
			};

			(orpcClient.mcp.configs.toggle as any).mockRejectedValueOnce(
				new Error("Toggle failed"),
			);

			const { result } = renderHook(() => useMcpConnection(), {
				wrapper,
			});

			result.current.toggleMutation.mutate({
				config: mockConfig,
				enabled: true,
			});

			await waitFor(() => {
				expect(result.current.toggleMutation.isError).toBe(true);
			});
		});
	});

	describe("handleConnect", () => {
		it("should open the OAuth authorization URL in a popup", async () => {
			const { orpcClient } = await import("@shared/lib/orpc-client");

			const mockConfig = {
				id: "config-1",
				authType: "OAUTH2",
			};

			(orpcClient.mcp.oauth.start as any).mockResolvedValueOnce({
				authorizationUrl: "https://auth.example.com/oauth?state=xyz",
			});

			const openSpy = vi
				.spyOn(window, "open")
				.mockReturnValue({} as Window);

			const { result } = renderHook(() => useMcpConnection(), {
				wrapper,
			});

			await result.current.handleConnect(mockConfig);

			expect(orpcClient.mcp.oauth.start).toHaveBeenCalledWith({
				configId: "config-1",
				redirectUri: expect.stringContaining("/api/mcp/oauth/callback"),
				autoDiscoverAndRegister: true,
			});
			expect(openSpy).toHaveBeenCalledWith(
				"https://auth.example.com/oauth?state=xyz",
				"oauth_popup",
				expect.any(String),
			);
		});
	});

	describe("oauthStatuses state", () => {
		it("should update oauthStatuses state after checkOAuthStatuses", async () => {
			const mockConfigs = [
				{
					id: "config-1",
					authType: "OAUTH2",
				},
			];

			const mockStatus = {
				data: {
					authenticated: true,
					tokenExpired: false,
					refreshTokenExpired: false,
					hasRefreshToken: true,
					tokenExpiresAt: "2025-12-31T23:59:59Z",
				},
			};

			(global.fetch as any).mockResolvedValueOnce({
				ok: true,
				json: async () => mockStatus,
			});

			const { result } = renderHook(() => useMcpConnection(), {
				wrapper,
			});

			expect(result.current.oauthStatuses).toEqual({});

			await result.current.checkOAuthStatuses(mockConfigs);

			await waitFor(() => {
				expect(result.current.oauthStatuses["config-1"]).toBeDefined();
			});

			expect(result.current.oauthStatuses["config-1"]).toEqual({
				authenticated: true,
				tokenExpired: false,
				refreshTokenExpired: false,
				hasRefreshToken: true,
				expiresAt: new Date("2025-12-31T23:59:59Z"),
			});
		});
	});
});
