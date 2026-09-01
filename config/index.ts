import type { Config } from "./types";

export const config = {
	appName: "Fabric AI",
	// Whether the app is live (true = show login, false = show waitlist)
	// Set to false during pre-launch to collect leads via the waitlist form
	isLive: process.env.NEXT_PUBLIC_IS_LIVE === "true",
	// Waitlist configuration (only used when isLive is false)
	waitlist: {
		title: "Join the Waitlist",
		description:
			"Be the first to know when we launch. Get early access and exclusive updates.",
	},
	// Internationalization
	i18n: {
		// Whether internationalization should be enabled (if disabled, you still need to define the locale you want to use below and set it as the default locale)
		enabled: false,
		// Define all locales here that should be available in the app
		// You need to define a label that is shown in the language selector and a currency that should be used for pricing with this locale
		locales: {
			en: {
				currency: "USD",
				label: "English",
			},
		},
		// The default locale is used if no locale is provided
		defaultLocale: "en",
		// The default currency is used for pricing if no currency is provided
		defaultCurrency: "USD",
		// The name of the cookie that is used to determine the locale
		localeCookieName: "NEXT_LOCALE",
	},
	// Organizations
	organizations: {
		// Whether organizations are enabled in general
		enable: true,
		// Whether billing for organizations should be enabled (below you can enable it for users instead)
		enableBilling: false,
		// Whether the organization should be hidden from the user (use this for multi-tenant applications)
		hideOrganization: false,
		// Should users be able to create new organizations? Otherwise only admin users can create them
		enableUsersToCreateOrganizations: true,
		// Whether users should be required to be in an organization. This will redirect users to the organization page after sign in
		requireOrganization: true,
		// Define forbidden organization slugs. Make sure to add all paths that you define as a route after /app/... to avoid routing issues
		forbiddenOrganizationSlugs: [
			"new-organization",
			"admin",
			"settings",
			"ai-demo",
			"organization-invitation",
			"project-invitation",
			"prompts",
			"agents",
			"mcp-servers",
			"chatbot",
			"projects",
		],
	},
	// Users
	users: {
		// Whether billing should be enabled for users (above you can enable it for organizations instead)
		// Fabric is free to use — users bring their own AI provider keys (BYOK), so billing is disabled.
		enableBilling: false,
		// Whether you want the user to go through an onboarding form after signup (can be defined in the OnboardingForm.tsx)
		enableOnboarding: true,
	},
	// Dashboard widgets
	dashboard: {
		// Project Invitation Welcome Widget (Fizzy #1457). Default ON; set
		// NEXT_PUBLIC_INVITE_WELCOME_WIDGET_ENABLED=false to roll back.
		inviteWelcomeWidget: {
			enabled:
				process.env.NEXT_PUBLIC_INVITE_WELCOME_WIDGET_ENABLED !==
				"false",
		},
	},
	// Authentication
	auth: {
		// Whether users should be able to create accounts (otherwise users can only be by admins)
		enableSignup: true,
		// Whether users should be able to sign in with a magic link
		enableMagicLink: true,
		// Whether users should be able to sign in with a social provider
		enableSocialLogin: true,
		// Whether users should be able to sign in with a passkey
		enablePasskeys: true,
		// Whether users should be able to sign in with a password
		enablePasswordLogin: true,
		// Whether users should be activate two factor authentication
		enableTwoFactor: true,
		// Where users should be redirected after sign in. The `postLogin=1`
		// marker tells the /app dispatcher this is a one-time post-login entry
		// (the only time it may resume the session's active org). A bare /app —
		// e.g. a tab refresh — must stay on the personal hub so multi-tab state
		// can't leak across tabs via the shared session.activeOrganizationId.
		redirectAfterSignIn: "/app?postLogin=1",
		// where users should be redirected after logout
		redirectAfterLogout: "/",
		// how long a session should be valid
		sessionCookieMaxAge: 60 * 60 * 24 * 30,
		// cookie name prefix for auth cookies (used by Better Auth and middleware)
		cookiePrefix: "fabric",
		captcha: {
			enabled: process.env.NEXT_PUBLIC_ENABLE_CAPTCHA === "true",
			siteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "",
		},
		tokenExpiry: {
			emailVerificationSeconds: 3600, // 1 hour
			passwordResetSeconds: 3600, // 1 hour
		},
	},
	// Mails
	mails: {
		// the from address for mails. Self-hosted deployments should set
		// MAIL_FROM to an address on their own domain.
		// `||` rather than `??` on purpose: `.env.example` ships MAIL_FROM=""
		// and a blank sender is worse than the default, so empty falls back too.
		from: process.env.MAIL_FROM || "noreply@fabric.pro",
	},
	// Support
	support: {
		// Where in-product help requests are delivered — the readiness
		// checklist's "Request help" is the first of them (Fizzy #2165).
		// Supplied per deployment rather than defaulted here: an address in
		// this file is published with the source, and the inbox that should
		// answer differs between our deployment and anyone else's. With none
		// set the request is still recorded, and the panel says plainly that
		// no email went out instead of claiming someone was told.
		// `||` rather than `??`, matching `mails.from`: a blank value must
		// read as "not configured" rather than as an address.
		email: process.env.SUPPORT_EMAIL || "",
	},
	// Frontend
	ui: {
		// the themes that should be available in the app
		enabledThemes: ["light", "dark"],
		// the default theme (dark for new users)
		defaultTheme: "dark",
		// the saas part of the application
		saas: {
			// whether the saas part should be enabled (otherwise all routes will be redirect to the marketing page)
			enabled: true,
			// whether the sidebar layout should be used
			useSidebarLayout: true,
		},
		// the marketing part of the application
		marketing: {
			// whether the marketing features should be enabled (otherwise all routes will be redirect to the saas part)
			enabled: true,
		},
	},
	// Storage
	storage: {
		// define the name of the buckets for the different types of files
		bucketNames: {
			avatars: process.env.NEXT_PUBLIC_AVATARS_BUCKET_NAME ?? "avatars",
			chatDocuments:
				process.env.NEXT_PUBLIC_CHAT_DOCUMENTS_BUCKET_NAME ??
				"chat-documents",
			projectContexts:
				process.env.NEXT_PUBLIC_PROJECT_CONTEXTS_BUCKET_NAME ??
				"project-contexts",
			workspaceDocuments:
				process.env.WORKSPACE_DOCUMENTS_BUCKET_NAME ??
				"workspace-documents",
			skills: process.env.SKILLS_BUCKET_NAME ?? "skills",
			projectDocumentAssets:
				process.env.PROJECT_DOCUMENT_ASSETS_BUCKET_NAME ??
				"project-document-assets",
			// Screenshots captured while a Fabric-driven test run walks a case.
			// PRIVATE: a screenshot of a signed-in page can contain anything the
			// customer's app shows, so these are read back through short-lived
			// signed URLs only.
			qaRunEvidence:
				process.env.QA_RUN_EVIDENCE_BUCKET_NAME ?? "qa-run-evidence",
		},
	},

	// RAG (Retrieval-Augmented Generation)
	rag: {
		// Qdrant vector database configuration
		qdrant: {
			url: process.env.QDRANT_URL ?? "http://localhost:6333",
			apiKey: process.env.QDRANT_API_KEY,
			// Collection names for different use cases
			collections: {
				chatDocuments:
					process.env.QDRANT_CHAT_COLLECTION_NAME ?? "chat-documents",
				projectContexts:
					process.env.QDRANT_PROJECT_COLLECTION_NAME ??
					"project-contexts",
			},
			// Legacy: Keep for backward compatibility
			collectionName:
				process.env.QDRANT_COLLECTION_NAME ?? "chat-documents",
		},
		// Document extraction strategy
		extraction: {
			strategy: "local-only" as const, // Phase 1: local extractors only
		},
	},
	// Databricks workspace integration (optional — self-hosted deployments)
	databricks: {
		host: process.env.DATABRICKS_HOST,
		clientId: process.env.DATABRICKS_CLIENT_ID,
		// Secrets (DATABRICKS_CLIENT_SECRET / DATABRICKS_TOKEN) are read by
		// @repo/databricks directly and intentionally not exposed here.
		databaseAuthProvider: process.env.DATABASE_AUTH_PROVIDER ?? "password",
	},
	// AI Configuration
	ai: {
		// Whether to route AI requests through Vercel AI Gateway
		// When enabled, all AI provider calls go through the gateway for centralized monitoring, cost tracking, and rate limiting
		// Documentation: https://sdk.vercel.ai/providers/ai-sdk-providers/ai-gateway
		enableGateway: !!process.env.AI_GATEWAY_API_KEY,
		// The Vercel AI Gateway API key
		// Get from: https://vercel.com/dashboard/ai/gateway
		// The gateway provides unified access to multiple AI providers
		gatewayApiKey: process.env.AI_GATEWAY_API_KEY,
		// List of enabled AI providers
		// Note: Actual model selection is now database-driven via AiModel, AiTaskModelDefault tables
		// Users configure their default provider and models in Settings > AI Providers
		enabledProviders: ["groq", "openai", "anthropic", "deepseek"],
		// Whether to use Temporal workflows for durable AI operations
		// When enabled, operations like title generation use Temporal for automatic retries and durability
		// Requires Temporal Server to be running (see docker-compose.yml)
		enableWorkflows: process.env.ENABLE_TEMPORAL_WORKFLOWS === "true",
	},
	// Prompts
	prompts: {
		// Whether the prompts feature should be enabled
		enabled: true,
		// Whether users should be able to create personal prompts (otherwise only org/system prompts)
		allowUserPrompts: true,
		// Default template format for new prompts
		defaultFormat: "PLAIN_TEXT" as const,
		// Maximum content size in characters (to prevent abuse)
		maxContentSize: 50000,
		// Whether to show system prompts in the browse interface
		showSystemPrompts: true,
	},
	// Payments
	payments: {
		aiMetering: {
			stripeRestrictedKey: process.env.STRIPE_AI_GATEWAY_RESTRICTED_KEY,
		},
		// define the products that should be available in the checkout
		// Fabric is free to use (BYOK) — the auto-assigned free plan is the only plan.
		plans: {
			// The free plan is treated differently. It will automatically be assigned if the user has no other plan.
			free: {
				isFree: true,
				hidden: true,
			},
		},
	},
} as const satisfies Config;

export type { Config };
