import { redirect } from "next/navigation";

/**
 * Legacy AI Gateway settings page - redirects to the new AI Providers page
 * which supports multiple providers (Vercel, OpenRouter, OpenAI, Anthropic, etc.)
 */
export default async function UserAiGatewaySettingsPage() {
	// Redirect to the new multi-provider settings page
	redirect("/app/settings/ai-providers");
}
