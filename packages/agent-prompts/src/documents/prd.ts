/**
 * Product Requirements Document (PRD) Prompt Configuration
 *
 * Expert-level prompt for generating comprehensive PRDs
 * following the PM-approved standard format.
 *
 * PRD FORMAT (PM Standard v2):
 * - Benefit Hypothesis (If we [build X] for [who], then [outcome] improves)
 * - Overview (Problem, Why Now, Goal, Non-goals)
 * - Users/Personas
 * - Success Metrics (table format)
 * - Scope (In/Out)
 * - Requirements (Must Have, Nice to Have, Non-Functional)
 * - Key Flows/Use Cases
 * - Dependencies/Risks
 * - Open Questions
 * - Work Breakdown
 * - Stakeholders
 * - Release Notes
 */

import type { DocumentPromptConfig } from "../types";

export const PRD_PROMPT: DocumentPromptConfig = {
	id: "prd",
	name: "Product Requirements Document (PRD)",

	persona: `You are a senior product manager with 15+ years of experience at leading technology companies including Google, Meta, and successful startups. You have shipped dozens of products used by millions of users.

Your PRDs follow the standard PM format and are known for:
- Starting with a clear Benefit Hypothesis that connects the build to measurable outcomes
- Concise problem statements that quantify impact
- Measurable success metrics in table format
- Clear scope boundaries (In Scope vs Out of Scope)
- Prioritized requirements (Must Have vs Nice to Have)
- User-centric flows with happy path, edge cases, and failure recovery
- Transparent risk identification with mitigation strategies

CRITICAL SECTIONS TO ALWAYS INCLUDE (in order):
1. Benefit Hypothesis - If we [build X] for [who], then [outcome] improves because [reason]
2. Overview - Problem, Why now, Goal, Non-goals
3. Users/Personas - Primary, Secondary, Internal users
4. Success Metrics - Goal/Metric table with measurement approach
5. Scope - In Scope and Out of Scope sections
6. Requirements - Must Have, Nice to Have, Non-Functional (Performance, Security, Reliability)
7. Key Flows/Use Cases - Happy path, Edge cases, Failure/recovery
8. Dependencies/Risks - Teams, APIs, vendors + Risk mitigation
9. Stakeholders - All roles involved

AVOID: Lengthy prose when tables work better. Optional sections like "Market Analysis" or "Appendices" should only be included if specifically relevant.`,

	sections: [
		{
			name: "Document Header",
			required: true,
			guidance: `Provide document control information in a clean format:

**Title:** The PRD title (clear, descriptive)

**Owner:** Product manager responsible

**Status:** Draft | Review | Approved | In Build | Shipped

**Target Release:** Planned release version/date

**Links:** Figma · Jira/Epics · Miro · Docs (as applicable)`,
			example: `## **PRD**

**Title:** Mobile Checkout Optimization

**Owner:** Jane Smith

**Status:** Review

**Target Release:** Q2 2024 (v2.5.0)

**Links:** [Figma](link) · [Jira Epic](link) · [Research Docs](link)`,
		},
		{
			name: "Benefit Hypothesis",
			required: true,
			guidance: `State the core hypothesis in the standard format:

If we **[build X]** for **[who]**, then **[measurable outcome]** improves because **[reason]**.

This should be a single, clear statement that connects the work to a measurable business or user outcome.`,
			example: `### **Benefit Hypothesis**

If we **implement one-tap checkout** for **returning mobile customers**, then **checkout conversion rate improves by 35%** because **friction from re-entering payment info is eliminated**.`,
		},
		{
			name: "Overview",
			required: true,
			guidance: `Provide a focused overview covering:

- **Problem:** What's broken / slow / costly today? Quantify where possible.
- **Why now:** What's the trigger, urgency, or opportunity?
- **Goal:** What we will achieve (1-3 bullets max).
- **Non-goals:** What we will *not* solve in this release.`,
			example: `### **Overview**

- **Problem:** Mobile checkout requires 8 steps and takes 4.5 minutes. 52% of users abandon at payment, costing $2.3M/quarter.
- **Why now:** Q2 initiative to increase mobile revenue; competitor launched one-tap last month.
- **Goal:**
  - Reduce checkout to 3 steps
  - Decrease abandonment to 30%
  - Support saved payment methods
- **Non-goals:**
  - Desktop checkout redesign (Phase 2)
  - New payment provider integration
  - Guest checkout support`,
		},
		{
			name: "Users / Personas",
			required: true,
			guidance: `Identify the users this feature serves:

- **Primary user:** The main user who benefits most
- **Secondary user:** Other users who will use this
- **Internal user (if any):** Internal teams affected`,
			example: `### **Users / Personas**

- **Primary user:** Returning mobile customers who shop weekly and value speed
- **Secondary user:** First-time purchasers who want to save payment info
- **Internal user (if any):** Customer support handling checkout issues`,
		},
		{
			name: "Success Metrics",
			required: true,
			guidance: `Define how success will be measured with a clear table:

| **Goal** | **Metric** |
| --- | --- |
| Goal description | Specific metric with target |

**How we'll measure:** Specify events/logs/dashboard and owner`,
			example: `### **Success Metrics**

| **Goal** | **Metric** |
| --- | --- |
| Faster checkout | Avg completion time < 90 seconds |
| Higher conversion | Checkout conversion rate > 70% |
| Reduced abandonment | Cart abandonment < 30% |
| User satisfaction | Post-checkout NPS > 50 |

**How we'll measure:** Amplitude events + checkout funnel dashboard, owned by Analytics team`,
		},
		{
			name: "Scope",
			required: true,
			guidance: `Clearly define what's included and excluded:

## **In Scope**
List what WILL be built/delivered

## **Out of Scope**
List what will NOT be addressed in this release`,
			example: `### **Scope**

## **In Scope**
- One-tap checkout for saved payment methods
- Secure payment tokenization
- Address autocomplete integration
- Order confirmation flow

## **Out of Scope**
- New payment provider integrations
- Desktop checkout changes
- Guest checkout support
- Subscription/recurring payments`,
		},
		{
			name: "Requirements",
			required: true,
			guidance: `List requirements by priority:

## **Must Have**
Critical features that define MVP - ship cannot happen without these

## **Nice to Have**
Features that enhance value but can be deferred if needed

**Non-Functional (only what matters)**
- Performance: Response time, throughput targets
- Security/Privacy: Compliance, data protection requirements
- Reliability: Uptime, failover requirements`,
			example: `### **Requirements**

## **Must Have**
- Save and retrieve payment methods securely (tokenized)
- One-tap purchase with saved payment + address
- Order confirmation with receipt
- Payment method management (add/remove/update)

## **Nice to Have**
- Apple Pay / Google Pay integration
- Multiple saved addresses
- Default payment method selection
- Purchase history quick-reorder

**Non-Functional (only what matters)**

- Performance: Checkout API < 200ms p95, page load < 2s
- Security/Privacy: PCI DSS Level 1, tokenized storage, GDPR consent
- Reliability: 99.9% uptime, graceful degradation if payment provider unavailable`,
		},
		{
			name: "Key Flows / Use Cases",
			required: true,
			guidance: `Document the main user flows:

1. **Happy path:** The ideal scenario when everything works
2. **Edge cases:** Unusual but valid scenarios
3. **Failure / recovery:** What happens when things go wrong`,
			example: `### **Key Flows / Use Cases**

1. **Happy path:**
   - User adds item to cart → taps "Buy Now" → confirms with Face ID → sees order confirmation
   - Total time: < 30 seconds

2. **Edge cases:**
   - Expired card: Prompt to update, offer alternative saved methods
   - Address changed: Show address selection before confirming
   - Low inventory: Show real-time availability, offer alternatives

3. **Failure / recovery:**
   - Payment declined: Show clear error, suggest retry or alternative method
   - Network timeout: Queue order locally, retry with exponential backoff
   - System error: Show apology, preserve cart, offer support contact`,
		},
		{
			name: "Dependencies / Risks",
			required: true,
			guidance: `Identify external dependencies and risks:

- **Dependencies:** Teams, APIs, vendors that must deliver
- **Risks:** What could go wrong, plus mitigation strategies`,
			example: `### **Dependencies / Risks**

- **Dependencies:**
  - Payment team: Tokenization API (due Week 4)
  - Platform team: iOS/Android SDK updates
  - Legal: Privacy policy updates for stored payment data

- **Risks:**
  - Payment API latency exceeds SLA → Mitigation: Implement caching, async confirmation
  - Low adoption of saved payments → Mitigation: Onboarding prompts, incentives
  - PCI audit delays → Mitigation: Start audit process in Week 1`,
		},
		{
			name: "Open Questions",
			required: false,
			guidance:
				"List unresolved questions that need stakeholder input or further research.",
			example: `### **Open Questions**

- Should we require re-authentication for purchases over $500?
- What's the retention period for saved payment methods?
- Do we need explicit opt-in for saving payment info, or is checkout consent sufficient?`,
		},
		{
			name: "Work Breakdown",
			required: false,
			guidance: `Break down the work into trackable units:

- **Epics:** Large bodies of work
- **Features:** Distinct capabilities within epics
- **Stories / Tasks:** Individual work items
- **Spikes (if needed):** Research or exploration tasks`,
			example: `### **Work Breakdown**

- **Epics:**
  - Epic 1: Payment Tokenization Infrastructure
  - Epic 2: One-Tap Checkout UI
  - Epic 3: Payment Method Management

- **Features:**
  - Secure token storage and retrieval
  - Checkout flow redesign
  - Payment method CRUD operations

- **Stories / Tasks:**
  - Implement payment token API
  - Design one-tap confirmation screen
  - Add biometric authentication
  - Build payment method list UI

- **Spikes (if needed):**
  - Evaluate Apple Pay vs custom tokenization performance`,
		},
		{
			name: "Stakeholders",
			required: true,
			guidance: `List all stakeholders and their roles:

- **Business/Sponsor:** Executive sponsor
- **PM/PO:** Product owner
- **Engineering:** Tech lead and team
- **Design:** UX/UI owner
- **QA:** Test lead
- **Data/Analytics:** Metrics owner
- **Security/Compliance:** Security reviewer
- **Support/Ops:** Operations and support`,
			example: `### **Stakeholders**

- **Business/Sponsor:** Sarah Chen, VP Commerce
- **PM/PO:** Jane Smith, Senior PM
- **Engineering:** Mike Lee, Tech Lead + Mobile Team
- **Design:** Alex Rivera, Senior UX Designer
- **QA:** Jordan Park, QA Lead
- **Data/Analytics:** Sam Johnson, Analytics Lead
- **Security/Compliance:** Pat Williams, Security Architect
- **Support/Ops:** Chris Taylor, Support Manager`,
		},
		{
			name: "Release Notes",
			required: false,
			guidance: `Draft release notes for when the feature ships:

What shipped + who it helps + any limits.`,
			example: `### **Release Notes**

**One-Tap Checkout** - Returning customers can now complete purchases in seconds using saved payment methods. Simply tap "Buy Now" and confirm with Face ID or Touch ID.

Available for iOS and Android. Supports Visa, Mastercard, and American Express. Guest checkout and PayPal coming in a future release.`,
		},
	],

	qualityChecklist: [
		"Benefit Hypothesis clearly states if/then/because with measurable outcome",
		"Problem statement quantifies impact (time, money, percentage)",
		"Goals are specific and limited to 1-3 items",
		"Non-goals explicitly state what's excluded",
		"User personas identify primary, secondary, and internal users",
		"Success metrics table has clear goals with specific measurable targets",
		"Measurement approach specifies tools/dashboards and owner",
		"In Scope and Out of Scope are clearly separated",
		"Must Have requirements define true MVP",
		"Nice to Have is appropriately deprioritized",
		"Non-functional requirements have specific targets (not vague)",
		"Key flows cover happy path, edge cases, AND failure scenarios",
		"Dependencies list specific teams/APIs with expected delivery",
		"Risks include mitigation strategies",
		"Stakeholder list is complete with names and roles",
	],

	antiPatterns: [
		"Vague benefit hypothesis without measurable outcome",
		"Problem statement without quantified impact",
		"Missing non-goals (scope will creep)",
		"Success metrics without specific targets or measurement plan",
		"Scope that only lists In Scope (missing Out of Scope)",
		"No distinction between Must Have and Nice to Have",
		"Non-functional requirements like 'should be fast' without targets",
		"Only happy path documented, no edge cases or failure handling",
		"Dependencies without owners or expected dates",
		"Risks listed without mitigation strategies",
		"Generic stakeholder roles without names",
	],

	examples: {
		goodBenefitHypothesis: `### **Benefit Hypothesis**

If we **add real-time collaboration** for **document editors**, then **time-to-publish decreases by 40%** because **reviewers can provide feedback inline instead of async email threads**.`,

		goodMetric: `| **Goal** | **Metric** |
| --- | --- |
| Faster collaboration | Avg document review time < 2 hours (from 8 hours) |
| Higher adoption | 80% of teams use real-time mode within 30 days |
| Reduced errors | Version conflict rate < 1% |

**How we'll measure:** Document analytics dashboard + user surveys, owned by Product Analytics`,
	},

	conditionalSections: [
		// Mobile App Conditional Sections
		{
			name: "Mobile Platform Requirements",
			required: false,
			condition: (attrs) =>
				attrs.projectType === "mobile" || !!attrs.hasMobileApp,
			trigger: "Included for mobile app projects",
			priority: 85,
			guidance: `Document platform-specific requirements:

**Platform Support**:
- iOS version requirements (minimum iOS 15+, target iOS 17+)
- Android version requirements (minimum Android 8+, target Android 14+)

**Platform-Specific Features**:
- iOS: Face ID, Apple Pay, HealthKit, etc.
- Android: Google Pay, Material Design 3, etc.

**App Store Requirements**:
- Required permissions and justification
- Privacy policy requirements`,
		},
		// API/Platform Conditional Sections
		{
			name: "Developer Experience (DX) Requirements",
			required: false,
			condition: (attrs) =>
				attrs.projectType === "api" ||
				!!attrs.hasAPI ||
				attrs.apiStyle != null,
			trigger: "Included for API/platform projects",
			priority: 75,
			guidance: `Define developer experience requirements for API consumers:

**Documentation**: Interactive API reference, getting started guide
**SDK Requirements**: Languages to support, package distribution
**Developer Dashboard**: API key management, usage analytics`,
		},
		// E-commerce Conditional Sections
		{
			name: "Payment & Checkout Requirements",
			required: false,
			condition: (attrs) => attrs.projectType === "ecommerce",
			trigger: "Included for e-commerce projects",
			priority: 90,
			guidance: `Define payment and checkout requirements:

**Payment Methods**: Cards, digital wallets, BNPL
**Security & Compliance**: PCI DSS level, 3D Secure
**Checkout Flow**: Guest vs account, steps`,
		},
		// B2B Conditional Sections
		{
			name: "Enterprise Features",
			required: false,
			condition: (attrs) =>
				attrs.isB2B === true || attrs.industry === "enterprise",
			trigger: "Included for B2B/Enterprise projects",
			priority: 75,
			guidance: `Define enterprise-specific features:

**Multi-Tenant Architecture**: Isolation, custom branding
**Advanced Access Control**: SSO, RBAC, audit logging
**Compliance & Governance**: Data residency, certifications`,
		},
	],
};
