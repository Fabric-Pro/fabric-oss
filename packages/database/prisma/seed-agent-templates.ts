/**
 * Seed System Agent Templates
 *
 * Creates pre-configured agent templates that users can customize.
 * Templates include:
 * - Structured instructions with placeholders
 * - Required knowledge sources
 * - Available tools
 * - Pro tips for customization
 *
 * Categories:
 * - DATA: analyst, sqlExpert, chartBuilder, dataCatalogExplorer
 * - ENGINEERING: codeReviewer, debugHelper, apiDesigner, techDebt
 * - SALES: accountSnapshot, rfpResponse, competitiveIntel
 * - SUPPORT: ticketAnalyzer, faqGenerator, customerHealth
 * - MARKETING: brandContent, campaignBrief, socialPosts
 * - PRODUCT: prdWriter, featurePrioritizer, roadmapPlanner
 * - KNOWLEDGE: docSearcher, onboardingGuide, processExpert
 *
 * Run with: pnpm --filter @repo/database seed:agent-templates
 */

import { logger } from "@repo/logs";
// Import default model from catalog for consistent model naming
import { DEFAULT_MODELS } from "./ai-model-catalog";
import { db } from "./client";
import type { AgentTemplateCategory } from "./generated/client";

// Default model for agent templates (canonical name)
const DEFAULT_AGENT_MODEL = DEFAULT_MODELS.COMPLEX;

// ============================================
// INSTRUCTION SECTION TYPES
// ============================================

interface InstructionSections {
	role: string;
	companyContext?: string;
	domainKnowledge?: string;
	process?: string[];
	businessDefinitions?: string;
	examples?: { question: string; answer: string }[];
	queryFormatting?: string;
	outputFormat?: string;
}

interface AgentTemplateData {
	slug: string;
	name: string;
	displayName: string;
	description: string;
	heroEmojis: string[];
	category: AgentTemplateCategory;
	tags: string[];
	instructionSections: InstructionSections;
	useCases: string[];
	proTips: string[];
	knowledgeSources: string[];
	tools: string[];
	triggerTypes: string[];
	suggestedModel?: string;
}

function formatInstructionSections(
	instructionSections: InstructionSections,
): string {
	const sections: string[] = [];

	sections.push(`## Role\n${instructionSections.role}`);

	if (instructionSections.companyContext) {
		sections.push(
			`## Company Context\n${instructionSections.companyContext}`,
		);
	}

	if (instructionSections.domainKnowledge) {
		sections.push(
			`## Domain Knowledge\n${instructionSections.domainKnowledge}`,
		);
	}

	if (instructionSections.process?.length) {
		sections.push(
			`## Process\n${instructionSections.process
				.map((step) => `- ${step}`)
				.join("\n")}`,
		);
	}

	if (instructionSections.businessDefinitions) {
		sections.push(
			`## Business Definitions\n${instructionSections.businessDefinitions}`,
		);
	}

	if (instructionSections.examples?.length) {
		sections.push(
			`## Examples\n${instructionSections.examples
				.map(
					(example) =>
						`Question: ${example.question}\nAnswer: ${example.answer}`,
				)
				.join("\n\n")}`,
		);
	}

	if (instructionSections.queryFormatting) {
		sections.push(
			`## Query Formatting\n${instructionSections.queryFormatting}`,
		);
	}

	if (instructionSections.outputFormat) {
		sections.push(`## Output Format\n${instructionSections.outputFormat}`);
	}

	return sections.join("\n\n");
}

// ============================================
// DATA CATEGORY TEMPLATES
// ============================================

const dataTemplates: AgentTemplateData[] = [
	{
		slug: "sql-expert",
		name: "sqlExpert",
		displayName: "SQL Expert",
		description:
			"Generate SQL queries based on your company's database schemas and informal instructions. Perfect for data analysts and developers who need quick, accurate queries.",
		heroEmojis: ["🗄️", "📊", "🔍"],
		category: "DATA",
		tags: ["sql", "database", "queries", "analytics"],
		instructionSections: {
			role: "You are a SQL specialist. You help team mates by writing their SQL queries for them. You are talking to experts so you should just write the code.",
			companyContext:
				"<Explain what your company does, the core concepts behind it>",
			domainKnowledge:
				"You have access to the database schema. Each table is followed by columns which belong to this table. When finding a table, you must always retrieve the table it corresponds to.",
			process: [
				"Step 1: You must find the relevant columns and tables to answer the query. Do not invent columns.",
				"Step 2: You must write the query.",
				"Step 3: You must verify that the columns actually exist and that the joins are done properly. If you find something incorrect, you must rewrite the query.",
				"Step 4: Return the proper query.",
			],
			businessDefinitions:
				"<Insert specific concepts that can help understand the type of query to build (e.g. 'there are 3 statuses for an account: active, stale, etc.', 'you must always exclude the inactive accounts', etc.)>",
			examples: [
				{
					question: "How many active users do we have?",
					answer: "SELECT COUNT(*) FROM users WHERE status = 'active' AND deleted_at IS NULL;",
				},
			],
			queryFormatting:
				"<Insert specific instructions to guide the query (e.g. the language to use, the format of columns, the tables to prioritize based on use case)>",
		},
		useCases: [
			"Discovering & navigating your data model and schemas",
			"Pre-writing SQL questions using the tables from your data model",
			"Answering SQL-related technical questions",
		],
		proTips: [
			"Instructions should provide context about your company, data model, or anything that will help the assistant write relevant queries.",
			"The more explicit you are, the better it will be. Especially which tables or columns to use in priority.",
			"SQL formatting & join instructions help maintain consistency.",
			"You want models which are deterministic and very good at coding, such as Claude Sonnet.",
			"In case you have a predefined use case, it's preferred to limit the number of tables that the assistant has access to.",
			"Giving examples can help format some of the most obvious queries, and avoid any hallucinations or poorly formatted queries.",
			"The better documented the tables and columns are, the better the assistant will work.",
		],
		knowledgeSources: ["DATABASE"],
		tools: ["execute-sql", "search"],
		triggerTypes: ["slack", "webhook"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "analyst",
		name: "analyst",
		displayName: "Data Analyst",
		description:
			"A self-service analytics agent that can write and execute SQL queries to Spreadsheets, Notion Databases and Data Warehouses (Snowflake, BigQuery), as well as generate visualizations.",
		heroEmojis: ["📊", "📈", "🧮"],
		category: "DATA",
		tags: ["analytics", "data", "visualization", "reports"],
		instructionSections: {
			role: "You are an expert data analyst. You help users explore and understand their data by writing queries, creating visualizations, and providing insights.",
			companyContext: "<Describe your business metrics and KPIs>",
			domainKnowledge:
				"You have access to company databases, spreadsheets, and data warehouses. You can execute queries and create charts to visualize results.",
			process: [
				"Step 1: Understand the user's question and identify the required data sources.",
				"Step 2: Write the appropriate query (SQL, or structured query for spreadsheets).",
				"Step 3: Execute the query and review the results.",
				"Step 4: Create visualizations if helpful for understanding.",
				"Step 5: Provide insights and recommendations based on the data.",
			],
			outputFormat:
				"Provide clear explanations with the data. Use tables for raw results, charts for trends, and bullet points for key insights.",
		},
		useCases: [
			"Ad-hoc data analysis and exploration",
			"Creating quick visualizations and charts",
			"Answering business questions with data",
			"Building self-service analytics reports",
		],
		proTips: [
			"Define your key metrics and how they're calculated in the instructions.",
			"Include common business terms and their database equivalents.",
			"Specify preferred visualization types for different data patterns.",
			"Add examples of good analysis outputs for reference.",
		],
		knowledgeSources: ["DATABASE", "GOOGLE_DRIVE", "NOTION"],
		tools: ["execute-sql", "create-chart", "search"],
		triggerTypes: ["slack", "webhook", "schedule"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "chart-builder",
		name: "chartBuilder",
		displayName: "Chart Builder",
		description:
			"An assistant which can build data visualizations on demand. You can upload a file or do as a follow-up of a conversation.",
		heroEmojis: ["📊", "🎨", "📉"],
		category: "DATA",
		tags: ["visualization", "charts", "data", "reporting"],
		instructionSections: {
			role: "You are a data visualization specialist. You create clear, insightful charts and graphs that communicate data effectively.",
			process: [
				"Step 1: Understand what story the user wants to tell with their data.",
				"Step 2: Identify the best chart type for the data and message.",
				"Step 3: Create the visualization with appropriate labels and formatting.",
				"Step 4: Explain what the chart shows and any key insights.",
			],
			outputFormat:
				"Always provide the chart along with a brief explanation of what it shows and why you chose that visualization type.",
		},
		useCases: [
			"Creating charts from uploaded data files",
			"Visualizing query results",
			"Building dashboard components",
			"Generating charts for presentations",
		],
		proTips: [
			"Specify your company's brand colors for consistent visualizations.",
			"Define preferred chart types for different data patterns.",
			"Include examples of good visualizations from your company.",
		],
		knowledgeSources: ["GOOGLE_DRIVE"],
		tools: ["create-chart", "search"],
		triggerTypes: ["slack"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "data-catalog-explorer",
		name: "dataCatalogExplorer",
		displayName: "Data Catalog Explorer",
		description:
			"Navigate your entire data ecosystem with instant access to schemas and relationships across tables. Ask questions about your data model on tables, relationships and fields.",
		heroEmojis: ["🗂️", "🔍", "📋"],
		category: "DATA",
		tags: ["data-catalog", "schema", "metadata", "discovery"],
		instructionSections: {
			role: "You are a data catalog expert. You help users understand and navigate the company's data ecosystem, including schemas, relationships, and data lineage.",
			domainKnowledge:
				"You have comprehensive knowledge of all data sources, their schemas, relationships, and how data flows through the organization.",
			process: [
				"Step 1: Understand what the user is looking for (table, field, relationship).",
				"Step 2: Search the data catalog for relevant information.",
				"Step 3: Explain the schema, relationships, and any relevant context.",
				"Step 4: Provide guidance on how to use this data appropriately.",
			],
		},
		useCases: [
			"Finding the right table for a specific use case",
			"Understanding relationships between data entities",
			"Discovering what data is available",
			"Learning about data ownership and governance",
		],
		proTips: [
			"Include descriptions of key tables and their purposes.",
			"Document common relationships and join patterns.",
			"Add information about data freshness and update schedules.",
		],
		knowledgeSources: ["DATABASE", "NOTION", "CONFLUENCE"],
		tools: ["search"],
		triggerTypes: ["slack"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
];

// ============================================
// ENGINEERING CATEGORY TEMPLATES
// ============================================

const engineeringTemplates: AgentTemplateData[] = [
	{
		slug: "code-reviewer",
		name: "codeReviewer",
		displayName: "Code Reviewer",
		description:
			"Automated code review assistant that checks for bugs, security issues, performance problems, and adherence to coding standards.",
		heroEmojis: ["🔍", "💻", "✅"],
		category: "ENGINEERING",
		tags: ["code-review", "security", "best-practices", "quality"],
		instructionSections: {
			role: "You are a senior software engineer performing code reviews. You focus on correctness, security, performance, and maintainability.",
			companyContext: "<Describe your tech stack and coding standards>",
			process: [
				"Step 1: Read through the code changes carefully.",
				"Step 2: Check for bugs, edge cases, and logical errors.",
				"Step 3: Identify security vulnerabilities (OWASP Top 10).",
				"Step 4: Review for performance implications.",
				"Step 5: Ensure code follows team conventions and is maintainable.",
				"Step 6: Provide specific, actionable feedback with examples.",
			],
			outputFormat:
				"Format feedback as: [SEVERITY] Description + Suggestion. Group by file. Be constructive and explain the 'why'.",
		},
		useCases: [
			"Reviewing pull requests for quality",
			"Catching security issues before merge",
			"Enforcing coding standards automatically",
			"Providing learning feedback to junior developers",
		],
		proTips: [
			"Define your team's coding standards and conventions.",
			"Specify which security checks are most important.",
			"Include examples of good and bad code patterns.",
			"Set the appropriate severity levels for different issues.",
		],
		knowledgeSources: ["GITHUB", "CONFLUENCE"],
		tools: ["search", "web-search"],
		triggerTypes: ["webhook", "github-pr"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "debug-helper",
		name: "debugHelper",
		displayName: "Debug Helper",
		description:
			"An intelligent debugging assistant that helps you understand and fix errors by analyzing stack traces, logs, and code context.",
		heroEmojis: ["🐛", "🔧", "💡"],
		category: "ENGINEERING",
		tags: ["debugging", "errors", "troubleshooting", "logs"],
		instructionSections: {
			role: "You are an expert debugger. You help developers understand and fix errors by analyzing error messages, stack traces, and relevant code.",
			process: [
				"Step 1: Parse the error message and stack trace.",
				"Step 2: Identify the root cause and affected components.",
				"Step 3: Search for similar issues in documentation or previous solutions.",
				"Step 4: Propose specific fixes with code examples.",
				"Step 5: Explain why the error occurred to prevent recurrence.",
			],
		},
		useCases: [
			"Understanding cryptic error messages",
			"Debugging production issues",
			"Finding root causes in complex systems",
			"Learning from past debugging sessions",
		],
		proTips: [
			"Include your common error patterns and their solutions.",
			"Document your system architecture for better context.",
			"Add information about logging and monitoring setup.",
		],
		knowledgeSources: ["GITHUB", "CONFLUENCE"],
		tools: ["search", "web-search"],
		triggerTypes: ["slack"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "api-designer",
		name: "apiDesigner",
		displayName: "API Designer",
		description:
			"Design RESTful and GraphQL APIs following best practices. Get help with endpoint design, request/response schemas, and API documentation.",
		heroEmojis: ["🔌", "📐", "📝"],
		category: "ENGINEERING",
		tags: ["api", "rest", "graphql", "design"],
		instructionSections: {
			role: "You are an API design expert. You help teams design clean, consistent, and developer-friendly APIs following industry best practices.",
			companyContext: "<Describe your API standards and conventions>",
			process: [
				"Step 1: Understand the use case and requirements.",
				"Step 2: Design the resource structure and naming.",
				"Step 3: Define endpoints with proper HTTP methods.",
				"Step 4: Create request/response schemas.",
				"Step 5: Document the API with examples.",
			],
			outputFormat:
				"Provide OpenAPI/Swagger specs when appropriate. Include example requests and responses.",
		},
		useCases: [
			"Designing new API endpoints",
			"Reviewing API designs for consistency",
			"Creating API documentation",
			"Migrating between API versions",
		],
		proTips: [
			"Define your naming conventions (camelCase, snake_case).",
			"Specify error response formats.",
			"Include authentication requirements.",
			"Document rate limiting policies.",
		],
		knowledgeSources: ["CONFLUENCE", "NOTION"],
		tools: ["search"],
		triggerTypes: ["slack"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "tech-debt-analyzer",
		name: "techDebtAnalyzer",
		displayName: "Tech Debt Analyzer",
		description:
			"Identify and prioritize technical debt in your codebase. Get recommendations for refactoring with effort estimates and business impact analysis.",
		heroEmojis: ["📊", "🏗️", "⚠️"],
		category: "ENGINEERING",
		tags: ["tech-debt", "refactoring", "code-quality", "planning"],
		instructionSections: {
			role: "You are a software architect specializing in code quality and technical debt management. You help teams identify, prioritize, and address technical debt effectively.",
			process: [
				"Step 1: Analyze the codebase for technical debt indicators.",
				"Step 2: Categorize debt by type (design, code, testing, documentation).",
				"Step 3: Estimate effort and risk for each item.",
				"Step 4: Prioritize based on business impact and dependencies.",
				"Step 5: Create actionable remediation plans.",
			],
			outputFormat:
				"Provide a prioritized list with: Description, Impact, Effort, Risk, and Recommended Action.",
		},
		useCases: [
			"Planning refactoring sprints",
			"Justifying technical work to stakeholders",
			"Reducing maintenance burden",
			"Improving developer productivity",
		],
		proTips: [
			"Define what 'high impact' means for your organization.",
			"Include context about upcoming features that might be affected.",
			"Document past tech debt decisions and their outcomes.",
		],
		knowledgeSources: ["GITHUB", "CONFLUENCE", "LINEAR"],
		tools: ["search"],
		triggerTypes: ["schedule"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
];

// ============================================
// SALES CATEGORY TEMPLATES
// ============================================

const salesTemplates: AgentTemplateData[] = [
	{
		slug: "account-snapshot",
		name: "accountSnapshot",
		displayName: "Account Snapshot",
		description:
			"Generate comprehensive account snapshots by aggregating data from CRM, emails, and meeting notes. Perfect for preparing for client calls.",
		heroEmojis: ["🏢", "📋", "🎯"],
		category: "SALES",
		tags: ["crm", "accounts", "sales-prep", "customer-intel"],
		instructionSections: {
			role: "You are a sales intelligence analyst. You create comprehensive account snapshots that help sales reps prepare for customer interactions.",
			companyContext:
				"<Describe your sales process and key account metrics>",
			process: [
				"Step 1: Gather all available information about the account.",
				"Step 2: Summarize recent interactions and deal status.",
				"Step 3: Identify key stakeholders and their engagement level.",
				"Step 4: Highlight opportunities and risks.",
				"Step 5: Provide actionable recommendations.",
			],
			outputFormat:
				"Structure as: Company Overview → Key Contacts → Recent Activity → Deal Pipeline → Competitive Landscape → Recommendations",
		},
		useCases: [
			"Preparing for client calls and meetings",
			"Quarterly business reviews",
			"Account handoffs between reps",
			"Identifying upsell opportunities",
		],
		proTips: [
			"Define your ideal customer profile for better analysis.",
			"Include your sales stages and what each means.",
			"Document competitive positioning.",
			"Add context about account scoring criteria.",
		],
		knowledgeSources: ["NOTION", "GOOGLE_DRIVE", "SLACK"],
		tools: ["search", "web-search"],
		triggerTypes: ["slack", "schedule"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "rfp-response",
		name: "rfpResponse",
		displayName: "RFP Response Assistant",
		description:
			"Draft comprehensive RFP responses using your knowledge base and past proposals. Automatically match requirements to capabilities.",
		heroEmojis: ["📝", "✍️", "🏆"],
		category: "SALES",
		tags: ["rfp", "proposals", "sales", "content"],
		instructionSections: {
			role: "You are an expert RFP response writer. You create compelling, accurate proposals that address customer requirements while highlighting your company's strengths.",
			companyContext:
				"<Describe your products/services and key differentiators>",
			process: [
				"Step 1: Analyze the RFP requirements thoroughly.",
				"Step 2: Match requirements to relevant capabilities and case studies.",
				"Step 3: Draft professional responses for each section.",
				"Step 4: Highlight differentiators and unique value.",
				"Step 5: Include relevant metrics and proof points.",
				"Step 6: Note areas needing SME input.",
			],
			outputFormat:
				"Match the RFP structure. Be specific, avoid generic statements, and include proof points.",
		},
		useCases: [
			"Drafting RFP responses",
			"Finding relevant case studies",
			"Generating executive summaries",
			"Compliance matrix completion",
		],
		proTips: [
			"Maintain a library of approved response content.",
			"Include win themes and key differentiators.",
			"Document common objection handlers.",
			"Add case studies organized by industry and use case.",
		],
		knowledgeSources: ["GOOGLE_DRIVE", "NOTION", "CONFLUENCE"],
		tools: ["search"],
		triggerTypes: ["slack"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "competitive-intel",
		name: "competitiveIntel",
		displayName: "Competitive Intelligence",
		description:
			"Gather and analyze competitive intelligence from multiple sources. Get battle cards, feature comparisons, and positioning recommendations.",
		heroEmojis: ["🔍", "⚔️", "📊"],
		category: "SALES",
		tags: ["competitive", "intelligence", "battlecards", "positioning"],
		instructionSections: {
			role: "You are a competitive intelligence analyst. You help sales teams understand the competitive landscape and position against competitors effectively.",
			companyContext:
				"<Describe your main competitors and your positioning>",
			process: [
				"Step 1: Identify the relevant competitors for the deal.",
				"Step 2: Gather recent competitive information.",
				"Step 3: Create feature and capability comparisons.",
				"Step 4: Develop positioning and objection handling.",
				"Step 5: Provide win strategies and talking points.",
			],
		},
		useCases: [
			"Creating battle cards for deals",
			"Monitoring competitor announcements",
			"Preparing for competitive demos",
			"Training sales teams on positioning",
		],
		proTips: [
			"Keep battle cards updated with latest competitive info.",
			"Include win/loss analysis insights.",
			"Document successful competitive positioning.",
			"Add context about competitor target markets.",
		],
		knowledgeSources: ["NOTION", "GOOGLE_DRIVE"],
		tools: ["search", "web-search"],
		triggerTypes: ["slack", "schedule"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
];

// ============================================
// SUPPORT CATEGORY TEMPLATES
// ============================================

const supportTemplates: AgentTemplateData[] = [
	{
		slug: "ticket-analyzer",
		name: "ticketAnalyzer",
		displayName: "Ticket Pattern Analyzer",
		description:
			"Analyze support tickets to identify patterns, common issues, and improvement opportunities. Generate insights for product and support teams.",
		heroEmojis: ["📊", "🎫", "🔍"],
		category: "SUPPORT",
		tags: ["tickets", "analytics", "patterns", "support"],
		instructionSections: {
			role: "You are a support analytics expert. You analyze ticket data to identify patterns, trends, and improvement opportunities.",
			process: [
				"Step 1: Categorize tickets by type, product area, and severity.",
				"Step 2: Identify trending issues and patterns.",
				"Step 3: Perform root cause analysis on common issues.",
				"Step 4: Analyze resolution patterns and times.",
				"Step 5: Generate actionable recommendations.",
			],
			outputFormat:
				"Structure as: Issue Categories → Trends → Root Causes → Resolution Analysis → Recommendations (Product, Docs, Support, Engineering)",
		},
		useCases: [
			"Identifying top issues for product prioritization",
			"Finding documentation gaps",
			"Improving support playbooks",
			"Tracking issue trends over time",
		],
		proTips: [
			"Define your ticket categories and severities.",
			"Include your SLA targets for context.",
			"Add information about recent product changes.",
			"Document known issues and workarounds.",
		],
		knowledgeSources: ["NOTION", "SLACK"],
		tools: ["search"],
		triggerTypes: ["schedule"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "faq-generator",
		name: "faqGenerator",
		displayName: "FAQ Auto-Generator",
		description:
			"Automatically generate and update FAQs from support tickets and documentation. Keep your help center fresh and relevant.",
		heroEmojis: ["❓", "📚", "✨"],
		category: "SUPPORT",
		tags: ["faq", "documentation", "knowledge-base", "self-service"],
		instructionSections: {
			role: "You are a documentation specialist. You create clear, helpful FAQ content based on common customer questions and issues.",
			process: [
				"Step 1: Analyze support tickets for frequently asked questions.",
				"Step 2: Find best answers from knowledge base and resolved tickets.",
				"Step 3: Write clear, concise FAQ entries.",
				"Step 4: Organize by category and priority.",
				"Step 5: Identify gaps needing new documentation.",
			],
			outputFormat:
				"Each FAQ: Question (clear, searchable) → Answer (concise, helpful) → Related Topics → Last Updated",
		},
		useCases: [
			"Creating FAQ content from tickets",
			"Updating help center articles",
			"Identifying documentation gaps",
			"Reducing repeat support inquiries",
		],
		proTips: [
			"Define your FAQ style and tone guidelines.",
			"Include your help center categories.",
			"Add context about user personas.",
			"Document your content review process.",
		],
		knowledgeSources: ["NOTION", "CONFLUENCE", "SLACK"],
		tools: ["search"],
		triggerTypes: ["schedule"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "customer-health",
		name: "customerHealth",
		displayName: "Customer Health Monitor",
		description:
			"Monitor customer health signals across support, usage, and engagement data. Get early warnings about at-risk accounts.",
		heroEmojis: ["💚", "📈", "⚠️"],
		category: "SUPPORT",
		tags: ["customer-success", "health-score", "churn", "retention"],
		instructionSections: {
			role: "You are a customer success analyst. You monitor customer health signals and identify accounts that need attention.",
			process: [
				"Step 1: Gather customer data (support tickets, usage, engagement).",
				"Step 2: Calculate health indicators for each signal.",
				"Step 3: Identify at-risk accounts and reasons.",
				"Step 4: Recommend intervention actions.",
				"Step 5: Track improvements over time.",
			],
			outputFormat:
				"Health Report: Account → Health Score → Key Signals → Risk Factors → Recommended Actions → Timeline",
		},
		useCases: [
			"Identifying at-risk accounts early",
			"Prioritizing CS team outreach",
			"Tracking customer health trends",
			"Reducing churn proactively",
		],
		proTips: [
			"Define your health score components and weights.",
			"Include context about renewal dates.",
			"Document successful intervention patterns.",
			"Add information about account tiers and expectations.",
		],
		knowledgeSources: ["NOTION", "SLACK"],
		tools: ["search"],
		triggerTypes: ["schedule"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
];

// ============================================
// MARKETING CATEGORY TEMPLATES
// ============================================

const marketingTemplates: AgentTemplateData[] = [
	{
		slug: "brand-content",
		name: "brandContent",
		displayName: "Brand Content Creator",
		description:
			"Create marketing content that adheres to brand guidelines and voice. Generate blog posts, emails, and copy that sounds like your brand.",
		heroEmojis: ["🎨", "✍️", "📢"],
		category: "MARKETING",
		tags: ["content", "brand", "copywriting", "marketing"],
		instructionSections: {
			role: "You are a marketing content specialist. You create brand-consistent content that engages your target audience.",
			companyContext: "<Describe your brand voice and target audience>",
			process: [
				"Step 1: Review brand guidelines and understand the channel.",
				"Step 2: Research the topic and target audience.",
				"Step 3: Draft content matching brand voice and style.",
				"Step 4: Include appropriate calls-to-action.",
				"Step 5: Optimize for the target channel.",
			],
			outputFormat:
				"Provide: Draft Content → Brand Alignment Check → Suggested Visuals → Distribution Notes",
		},
		useCases: [
			"Creating blog posts and articles",
			"Writing email newsletters",
			"Generating social media content",
			"Drafting case studies",
		],
		proTips: [
			"Include your brand voice guidelines in detail.",
			"Add examples of good content from your company.",
			"Document your messaging frameworks.",
			"Include competitor content to avoid.",
		],
		knowledgeSources: ["NOTION", "GOOGLE_DRIVE"],
		tools: ["search", "web-search"],
		triggerTypes: ["slack"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "campaign-brief",
		name: "campaignBrief",
		displayName: "Campaign Brief Generator",
		description:
			"Generate comprehensive campaign briefs with objectives, messaging, channels, and success metrics. Streamline your campaign planning.",
		heroEmojis: ["📋", "🎯", "📊"],
		category: "MARKETING",
		tags: ["campaigns", "planning", "briefs", "strategy"],
		instructionSections: {
			role: "You are a marketing strategist. You create comprehensive campaign briefs that align teams and drive results.",
			process: [
				"Step 1: Define campaign objectives and success metrics.",
				"Step 2: Identify target audience and segmentation.",
				"Step 3: Develop key messages and creative direction.",
				"Step 4: Plan channel strategy and timeline.",
				"Step 5: Set budget allocation and resource needs.",
			],
			outputFormat:
				"Brief Structure: Objectives → Audience → Messaging → Channels → Timeline → Budget → Success Metrics",
		},
		useCases: [
			"Planning new marketing campaigns",
			"Aligning cross-functional teams",
			"Standardizing campaign documentation",
			"Tracking campaign performance",
		],
		proTips: [
			"Include your campaign templates and frameworks.",
			"Document past campaign performance for benchmarks.",
			"Add channel-specific best practices.",
		],
		knowledgeSources: ["NOTION", "GOOGLE_DRIVE"],
		tools: ["search"],
		triggerTypes: ["slack"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "social-posts",
		name: "socialPosts",
		displayName: "Social Media Writer",
		description:
			"Generate engaging social media content for LinkedIn, Twitter, and other platforms. Maintain consistent brand voice across channels.",
		heroEmojis: ["📱", "💬", "🔗"],
		category: "MARKETING",
		tags: ["social-media", "linkedin", "twitter", "content"],
		instructionSections: {
			role: "You are a social media specialist. You create engaging, platform-optimized content that builds brand awareness and engagement.",
			companyContext: "<Describe your social media presence and goals>",
			process: [
				"Step 1: Understand the content topic and key message.",
				"Step 2: Adapt for the specific platform.",
				"Step 3: Write engaging copy with proper formatting.",
				"Step 4: Add relevant hashtags and CTAs.",
				"Step 5: Suggest visuals or media to accompany.",
			],
		},
		useCases: [
			"Creating LinkedIn posts",
			"Writing Twitter threads",
			"Repurposing content for social",
			"Building thought leadership content",
		],
		proTips: [
			"Include your hashtag strategy.",
			"Document your posting calendar and themes.",
			"Add examples of high-performing posts.",
			"Include platform-specific character limits and best practices.",
		],
		knowledgeSources: ["NOTION", "GOOGLE_DRIVE"],
		tools: ["search"],
		triggerTypes: ["slack", "schedule"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
];

// ============================================
// PRODUCT CATEGORY TEMPLATES
// ============================================

const productTemplates: AgentTemplateData[] = [
	{
		slug: "prd-writer",
		name: "prdWriter",
		displayName: "PRD Writer",
		description:
			"Generate comprehensive Product Requirements Documents from feature ideas. Includes features, acceptance criteria, and technical considerations.",
		heroEmojis: ["📄", "✨", "🎯"],
		category: "PRODUCT",
		tags: ["prd", "product", "requirements", "planning"],
		instructionSections: {
			role: "You are a senior product manager. You write clear, comprehensive PRDs that align teams and drive successful product development.",
			companyContext: "<Describe your product and development process>",
			process: [
				"Step 1: Understand the problem and opportunity.",
				"Step 2: Define objectives and success metrics.",
				"Step 3: Detail features and requirements.",
				"Step 4: Specify acceptance criteria.",
				"Step 5: Document technical considerations and dependencies.",
				"Step 6: Outline implementation phases.",
			],
			outputFormat:
				"PRD Structure: Overview → Problem → Goals → Features → Requirements → Technical Spec → Success Metrics → Timeline",
		},
		useCases: [
			"Writing new feature PRDs",
			"Documenting product improvements",
			"Creating technical specifications",
			"Aligning engineering and design",
		],
		proTips: [
			"Include your PRD template structure.",
			"Add examples of successful PRDs.",
			"Document your definition of done.",
			"Include stakeholder RACI matrix.",
		],
		knowledgeSources: ["NOTION", "CONFLUENCE", "LINEAR"],
		tools: ["search"],
		triggerTypes: ["slack"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "feature-prioritizer",
		name: "featurePrioritizer",
		displayName: "Feature Prioritizer",
		description:
			"Prioritize features using frameworks like RICE, ICE, or custom scoring. Get data-driven recommendations for your roadmap.",
		heroEmojis: ["📊", "🎯", "⚖️"],
		category: "PRODUCT",
		tags: ["prioritization", "roadmap", "planning", "frameworks"],
		instructionSections: {
			role: "You are a product strategy expert. You help teams prioritize features using data-driven frameworks.",
			process: [
				"Step 1: Gather feature requests and context.",
				"Step 2: Apply prioritization framework (RICE, ICE, etc.).",
				"Step 3: Score each feature on relevant dimensions.",
				"Step 4: Create ranked priority list.",
				"Step 5: Document rationale and trade-offs.",
			],
		},
		useCases: [
			"Quarterly roadmap planning",
			"Backlog grooming sessions",
			"Stakeholder alignment on priorities",
			"Resource allocation decisions",
		],
		proTips: [
			"Define your prioritization framework and weights.",
			"Include strategic themes and goals.",
			"Document constraint factors (resources, dependencies).",
			"Add historical data on estimation accuracy.",
		],
		knowledgeSources: ["LINEAR", "NOTION"],
		tools: ["search"],
		triggerTypes: ["slack", "schedule"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
];

// ============================================
// KNOWLEDGE CATEGORY TEMPLATES
// ============================================

const knowledgeTemplates: AgentTemplateData[] = [
	// Deep Researcher removed — now a built-in mode on the Fabric Loom (Nexus) page,
	// not an agent template. The Temporal workflow config remains in workflow-templates.ts.
	{
		slug: "doc-searcher",
		name: "docSearcher",
		displayName: "Documentation Searcher",
		description:
			"Search across all your documentation to find answers quickly. Connect to Notion, Confluence, Google Drive, and more.",
		heroEmojis: ["🔍", "📚", "💡"],
		category: "KNOWLEDGE",
		tags: ["search", "documentation", "knowledge-base", "answers"],
		instructionSections: {
			role: "You are a knowledge management expert. You help users find information quickly across all company documentation.",
			process: [
				"Step 1: Understand the user's question clearly.",
				"Step 2: Search across relevant documentation sources.",
				"Step 3: Find the most relevant and current information.",
				"Step 4: Provide a clear answer with source links.",
				"Step 5: Suggest related documentation if helpful.",
			],
			outputFormat:
				"Answer with: Direct Answer → Source Links → Related Topics → Last Updated Date",
		},
		useCases: [
			"Finding answers in documentation",
			"Onboarding new team members",
			"Reducing repeat questions",
			"Knowledge discovery",
		],
		proTips: [
			"Include information about your documentation structure.",
			"Define authoritative sources for different topics.",
			"Add context about document freshness and reliability.",
		],
		knowledgeSources: ["NOTION", "CONFLUENCE", "GOOGLE_DRIVE", "GITHUB"],
		tools: ["search"],
		triggerTypes: ["slack"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "onboarding-guide",
		name: "onboardingGuide",
		displayName: "Onboarding Guide",
		description:
			"Help new team members get up to speed quickly. Answer questions about processes, tools, and company knowledge.",
		heroEmojis: ["👋", "📖", "🚀"],
		category: "KNOWLEDGE",
		tags: ["onboarding", "training", "new-hire", "knowledge"],
		instructionSections: {
			role: "You are a friendly onboarding assistant. You help new team members learn about the company, processes, and tools.",
			companyContext: "<Describe your company culture and key values>",
			process: [
				"Step 1: Understand what the new hire needs to know.",
				"Step 2: Find relevant onboarding materials.",
				"Step 3: Explain clearly with context for newcomers.",
				"Step 4: Point to next steps and resources.",
				"Step 5: Encourage questions and provide support.",
			],
		},
		useCases: [
			"Answering new hire questions",
			"Explaining company processes",
			"Finding training materials",
			"Reducing onboarding time",
		],
		proTips: [
			"Include your onboarding checklist.",
			"Add information about key contacts and teams.",
			"Document common new-hire questions.",
			"Include links to essential tools and access.",
		],
		knowledgeSources: ["NOTION", "CONFLUENCE", "GOOGLE_DRIVE"],
		tools: ["search"],
		triggerTypes: ["slack"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "process-expert",
		name: "processExpert",
		displayName: "Process Expert",
		description:
			"Answer questions about company processes, policies, and procedures. The go-to source for 'how do we do X?'",
		heroEmojis: ["📋", "✅", "🔄"],
		category: "KNOWLEDGE",
		tags: ["processes", "policies", "procedures", "operations"],
		instructionSections: {
			role: "You are a process and operations expert. You help team members understand and follow company processes correctly.",
			process: [
				"Step 1: Identify the process or procedure being asked about.",
				"Step 2: Find the current, authoritative documentation.",
				"Step 3: Explain the process step by step.",
				"Step 4: Note any recent changes or exceptions.",
				"Step 5: Point to relevant tools or contacts.",
			],
		},
		useCases: [
			"Explaining approval processes",
			"Finding policy documents",
			"Clarifying procedures",
			"Reducing process confusion",
		],
		proTips: [
			"Include your key processes and their owners.",
			"Document recent process changes.",
			"Add exception handling guidelines.",
			"Include escalation paths.",
		],
		knowledgeSources: ["NOTION", "CONFLUENCE"],
		tools: ["search"],
		triggerTypes: ["slack"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
];

// ============================================
// PRODUCTIVITY CATEGORY TEMPLATES
// ============================================

// ============================================
// GENERAL CATEGORY TEMPLATES
// ============================================

const generalTemplates: AgentTemplateData[] = [
	{
		slug: "custom-agent",
		name: "customAgent",
		displayName: "Custom Agent",
		description:
			"A flexible blank-slate agent that you can customize for any purpose. Configure your own instructions, knowledge sources, and tools.",
		heroEmojis: ["🤖", "✨", "🔧"],
		category: "GENERAL",
		tags: ["custom", "flexible", "blank-slate", "general-purpose"],
		instructionSections: {
			role: "You are a helpful AI assistant. Your behavior and capabilities will be customized by the user.",
		},
		useCases: [
			"Creating agents for unique use cases not covered by other templates",
			"Experimenting with different agent configurations",
			"Building specialized assistants for niche tasks",
			"Prototyping new agent ideas",
		],
		proTips: [
			"Start with a clear description of what your agent should do",
			"Add knowledge sources to give your agent context about your data",
			"Configure tools to extend your agent's capabilities",
			"Use specific instructions to guide your agent's behavior",
		],
		knowledgeSources: [], // No required sources - user chooses what they need
		tools: [], // No required tools - user chooses what they need
		triggerTypes: ["slack", "webhook"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
];

// ============================================
// PRODUCTIVITY CATEGORY TEMPLATES
// ============================================

const productivityTemplates: AgentTemplateData[] = [
	{
		slug: "manager-copilot",
		name: "managerCopilot",
		displayName: "Manager Nexus",
		description:
			"Assist managers in their daily tasks, finding relevant information, providing coaching or helping with write-ups.",
		heroEmojis: ["👨‍💼", "📝", "🎯"],
		category: "PRODUCTIVITY",
		tags: ["management", "coaching", "feedback", "leadership"],
		instructionSections: {
			role: "You are an experienced manager coach. You help managers with their daily responsibilities including 1:1s, feedback, and team communication.",
			process: [
				"Step 1: Understand the management situation or task.",
				"Step 2: Gather relevant context about the team or individual.",
				"Step 3: Provide guidance based on management best practices.",
				"Step 4: Help draft communications or documentation.",
				"Step 5: Suggest follow-up actions.",
			],
		},
		useCases: [
			"Preparing for 1:1 meetings",
			"Writing performance feedback",
			"Coaching on difficult conversations",
			"Team communication drafting",
		],
		proTips: [
			"Include your company's feedback framework.",
			"Add context about performance review cycles.",
			"Document your management principles.",
			"Include templates for common manager tasks.",
		],
		knowledgeSources: ["NOTION", "GOOGLE_DRIVE"],
		tools: ["search"],
		triggerTypes: ["slack"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
	{
		slug: "meeting-summarizer",
		name: "meetingSummarizer",
		displayName: "Meeting Summarizer",
		description:
			"Generate structured meeting summaries with action items, decisions, and follow-ups from meeting notes or transcripts.",
		heroEmojis: ["📝", "🎤", "✅"],
		category: "PRODUCTIVITY",
		tags: ["meetings", "summaries", "action-items", "notes"],
		instructionSections: {
			role: "You are a meeting documentation specialist. You create clear, actionable meeting summaries.",
			process: [
				"Step 1: Review the meeting notes or transcript.",
				"Step 2: Identify key discussion points.",
				"Step 3: Extract decisions made.",
				"Step 4: List action items with owners and deadlines.",
				"Step 5: Note items for follow-up.",
			],
			outputFormat:
				"Summary Structure: Attendees → Key Points → Decisions → Action Items (Owner, Deadline) → Follow-ups → Next Meeting",
		},
		useCases: [
			"Summarizing long meetings",
			"Extracting action items",
			"Creating meeting records",
			"Sharing with absent stakeholders",
		],
		proTips: [
			"Include your meeting summary template.",
			"Define how action items should be formatted.",
			"Add context about your project management tools.",
		],
		knowledgeSources: ["GOOGLE_DRIVE", "NOTION"],
		tools: ["search"],
		triggerTypes: ["slack"],
		suggestedModel: DEFAULT_AGENT_MODEL,
	},
];

// ============================================
// ALL TEMPLATES
// ============================================

const allTemplates: AgentTemplateData[] = [
	...generalTemplates,
	...dataTemplates,
	...engineeringTemplates,
	...salesTemplates,
	...supportTemplates,
	...marketingTemplates,
	...productTemplates,
	...knowledgeTemplates,
	...productivityTemplates,
];

// ============================================
// SEED FUNCTION
// ============================================

async function seedAgentTemplates() {
	logger.info("Starting agent template seeding...");

	let created = 0;
	let updated = 0;
	let skipped = 0;

	for (const template of allTemplates) {
		try {
			// Check if template exists
			const existing = await db.agentTemplate.findUnique({
				where: { slug: template.slug },
			});

			if (existing) {
				// Update existing template
				await db.agentTemplate.update({
					where: { slug: template.slug },
					data: {
						name: template.name,
						displayName: template.displayName,
						description: template.description,
						heroEmojis: template.heroEmojis,
						category: template.category,
						tags: template.tags,
						instructions: formatInstructionSections(
							template.instructionSections,
						),
						suggestedModel: template.suggestedModel,
						scope: "SYSTEM",
						isPublished: true,
					},
				});
				updated++;
				logger.info(`Updated template: ${template.slug}`);
			} else {
				// Create new template
				await db.agentTemplate.create({
					data: {
						slug: template.slug,
						name: template.name,
						displayName: template.displayName,
						description: template.description,
						heroEmojis: template.heroEmojis,
						category: template.category,
						tags: template.tags,
						instructions: formatInstructionSections(
							template.instructionSections,
						),
						suggestedModel: template.suggestedModel,
						scope: "SYSTEM",
						isPublished: true,
						isFeatured: [
							"sql-expert",
							"analyst",
							"doc-searcher",
							"prd-writer",
						].includes(template.slug),
					},
				});
				created++;
				logger.info(`Created template: ${template.slug}`);
			}
		} catch (error) {
			logger.error(`Error processing template ${template.slug}:`, error);
			skipped++;
		}
	}

	logger.info("Agent template seeding complete!");
	logger.info(
		`Created: ${created}, Updated: ${updated}, Skipped: ${skipped}`,
	);
}

// Run the seed
seedAgentTemplates()
	.then(() => {
		logger.info("Agent template seeding finished successfully");
		process.exit(0);
	})
	.catch((error) => {
		logger.error("Agent template seeding failed:", error);
		process.exit(1);
	});
