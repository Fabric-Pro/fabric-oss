export type Config = {
	appName: string;
	// Whether the app is live and accepting users, or in pre-launch waitlist mode
	isLive: boolean;
	waitlist: {
		// Title shown on the waitlist form
		title: string;
		// Description shown on the waitlist form
		description: string;
	};
	i18n: {
		enabled: boolean;
		locales: { [locale: string]: { currency: string; label: string } };
		defaultLocale: string;
		defaultCurrency: string;
		localeCookieName: string;
	};
	organizations: {
		enable: boolean;
		enableBilling: boolean;
		enableUsersToCreateOrganizations: boolean;
		requireOrganization: boolean;
		hideOrganization: boolean;
		forbiddenOrganizationSlugs: string[];
	};
	users: {
		enableBilling: boolean;
		enableOnboarding: boolean;
	};
	dashboard: {
		inviteWelcomeWidget: {
			enabled: boolean;
		};
	};
	auth: {
		enableSignup: boolean;
		enableMagicLink: boolean;
		enableSocialLogin: boolean;
		enablePasskeys: boolean;
		enablePasswordLogin: boolean;
		enableTwoFactor: boolean;
		redirectAfterSignIn: string;
		redirectAfterLogout: string;
		sessionCookieMaxAge: number;
		cookiePrefix: string;
		captcha: {
			enabled: boolean;
			siteKey: string;
		};
		tokenExpiry: {
			emailVerificationSeconds: number;
			passwordResetSeconds: number;
		};
	};
	mails: {
		from: string;
	};
	support: {
		email: string;
	};
	storage: {
		bucketNames: {
			avatars: string;
			chatDocuments: string;
			projectContexts: string;
			workspaceDocuments: string;
			skills: string;
			projectDocumentAssets: string;
			qaRunEvidence: string;
		};
	};
	ui: {
		enabledThemes: Array<"light" | "dark">;
		defaultTheme: Config["ui"]["enabledThemes"][number];
		saas: {
			enabled: boolean;
			useSidebarLayout: boolean;
		};
		marketing: {
			enabled: boolean;
		};
	};
	ai: {
		enableGateway: boolean;
		gatewayApiKey?: string;
		enabledProviders: Array<"openai" | "anthropic" | "deepseek" | "groq">;
		enableWorkflows: boolean;
	};
	prompts: {
		enabled: boolean;
		allowUserPrompts: boolean;
		defaultFormat:
			| "PLAIN_TEXT"
			| "MARKDOWN"
			| "HANDLEBARS"
			| "MUSTACHE"
			| "LIQUID"
			| "JINJA2";
		maxContentSize: number;
		showSystemPrompts: boolean;
	};
	payments: {
		aiMetering?: {
			stripeRestrictedKey?: string;
		};
		plans: {
			[id: string]: {
				hidden?: boolean;
				isFree?: boolean;
				isEnterprise?: boolean;
				recommended?: boolean;
				prices?: Array<
					{
						productId: string;
						amount: number;
						currency: string;
						hidden?: boolean;
					} & (
						| {
								type: "recurring";
								interval: "month" | "year" | "week";
								intervalCount?: number;
								trialPeriodDays?: number;
								seatBased?: boolean;
						  }
						| {
								type: "one-time";
						  }
					)
				>;
			};
		};
	};
	rag: {
		qdrant: {
			url: string;
			apiKey?: string;
			collectionName: string;
			collections: {
				chatDocuments: string;
				projectContexts: string;
			};
		};
		extraction: {
			strategy: "local-only" | "external-fallback" | "external-only";
		};
	};
	// Databricks workspace integration (optional — self-hosted deployments)
	databricks: {
		host?: string;
		clientId?: string;
		// Secrets (DATABRICKS_CLIENT_SECRET / DATABRICKS_TOKEN) are read by
		// @repo/databricks directly and intentionally not exposed here.
		databaseAuthProvider: string;
	};
};
