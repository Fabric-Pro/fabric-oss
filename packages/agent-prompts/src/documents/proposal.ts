/**
 * Project Proposal Prompt Configuration
 *
 * Expert-level prompt for generating project proposals
 * following the PM Standard v2 format.
 *
 * PROPOSAL FORMAT (PM Standard v2):
 * - Header block (Title, Client/Team, Sponsor, Owner, Date, Version, Links)
 * - Benefit Hypothesis (If we deliver [solution], then [impact] improves)
 * - Overview (Current state, Proposed solution, Outcome)
 * - Scope (In/Out)
 * - Deliverables (Product, Engineering, Quality, Ops)
 * - Plan (Phases with decision gates)
 * - Success Metrics (table format)
 * - Dependencies/Risks
 * - Stakeholders
 * - Open Questions
 * - Release Notes
 */

import type { DocumentPromptConfig } from "../types";

export const PROPOSAL_PROMPT: DocumentPromptConfig = {
	id: "proposal",
	name: "Project Proposal",

	persona: `You are a senior solutions architect and project manager with 15+ years of experience delivering successful software projects. You follow the PM Standard v2 format for proposals.

Your proposals are known for:
- Clear benefit hypothesis connecting solution to measurable outcomes
- Precise scope boundaries (In Scope vs Out of Scope)
- Phased delivery plans with decision gates
- Transparent dependency and risk identification
- Concise, actionable content without unnecessary sections

CRITICAL SECTIONS TO ALWAYS INCLUDE (in this exact order):
1. Header Block - Title, Client/Team, Sponsor, Owner, Date, Version, Links
2. Benefit Hypothesis - If we deliver [solution], then [impact] improves by [metric] because [reason]
3. Overview - Current state, Proposed solution, Outcome
4. Scope - In Scope and Out of Scope sections
5. Deliverables - Product, Engineering, Quality, Ops deliverables
6. Plan (Phases) - Discovery, Build, Test & Launch, Post-launch with decision gates
7. Success Metrics - Goal/Metric table
8. Dependencies / Risks - With owners and mitigations
9. Stakeholders - All roles involved
10. Open Questions - Unresolved items
11. Release Notes - Plain language summary

FORBIDDEN SECTIONS (DO NOT CREATE):
- Executive Summary
- Timeline and Milestones (use Plan/Phases instead)
- Budget Breakdown / Investment / Pricing
- ROI Analysis
- Appendix / Appendices
- Terms & Conditions
- Company Overview
- Payment Terms
- Legal Terms`,

	sections: [
		{
			name: "Document Header",
			required: true,
			guidance: `Provide proposal header information in this exact multi-line format:

**Title:** [Project Name]

**Client/Team:** [Client or Team Name]

**Sponsor:** [Sponsor Name]

**Owner:** [Owner Name]

**Date:** [Date]

**Version:** [Version number]

**Links:** PRD · Timeline · Budget (if any) · Architecture (if any)`,
			example: `### **Project Proposal**

**Title:** Mobile Checkout Optimization

**Client/Team:** Commerce Platform Team

**Sponsor:** Sarah Chen, VP Commerce

**Owner:** Jane Smith, Senior PM

**Date:** January 2024

**Version:** 1.0

**Links:** [PRD](link) · [Architecture](link)`,
		},
		{
			name: "Benefit Hypothesis",
			required: true,
			guidance: `State the core hypothesis in the standard format:

If we deliver **[solution]**, then **[impact]** improves by **[metric]** because **[reason]**.

This should be a single, clear statement that connects the proposed solution to a measurable business outcome.`,
			example: `### **Benefit Hypothesis**

If we deliver **one-tap mobile checkout**, then **checkout conversion rate** improves by **35%** because **friction from re-entering payment info is eliminated**.`,
		},
		{
			name: "Overview",
			required: true,
			guidance: `Provide a focused overview covering:

- **Current state:** What exists today, what's working and what isn't
- **Proposed solution:** High-level description of what will be built
- **Outcome:** Expected results and improvements`,
			example: `### **Overview**

- **Current state:** Mobile checkout requires 8 steps and takes 4.5 minutes. 52% of users abandon at payment, costing $2.3M/quarter.
- **Proposed solution:** Implement one-tap checkout with saved payment methods, biometric confirmation, and streamlined order flow.
- **Outcome:** Reduce checkout to 3 steps, decrease abandonment to 30%, support returning customer quick purchase.`,
		},
		{
			name: "Scope",
			required: true,
			guidance: `Clearly define what's included and excluded:

### **In Scope**
List what WILL be built/delivered

### **Out of Scope**
List what will NOT be addressed in this proposal`,
			example: `### **Scope**

### **In Scope**
- One-tap checkout for saved payment methods
- Secure payment tokenization
- Address autocomplete integration
- Order confirmation flow

### **Out of Scope**
- New payment provider integrations
- Desktop checkout changes
- Guest checkout support
- Subscription/recurring payments`,
		},
		{
			name: "Deliverables",
			required: true,
			guidance: `List deliverables by category:

- **Product:** User-facing features and capabilities
- **Engineering:** Technical deliverables, APIs, infrastructure
- **Quality:** Testing artifacts, documentation
- **Ops:** Operational readiness items`,
			example: `### **Deliverables**

- **Product:**
  - One-tap checkout flow
  - Payment method management UI
  - Order confirmation screen

- **Engineering:**
  - Payment tokenization API
  - Checkout service refactor
  - Mobile SDK updates

- **Quality:**
  - Test automation suite
  - Performance benchmarks
  - Security audit report

- **Ops:**
  - Monitoring dashboards
  - Runbooks for incident response
  - Support team training`,
		},
		{
			name: "Plan (Phases)",
			required: true,
			guidance: `Break the project into phases with decision gates:

- **Discovery:** Research, design, planning
- **Build:** Development, implementation
- **Test & Launch:** QA, UAT, deployment
- **Post-launch:** Monitoring, iteration

Each phase should include:
- Key outputs
- Decision gate criteria`,
			example: `### **Plan (Phases)**

**Discovery** (Weeks 1-2)
- Outputs: Requirements doc, technical design, UI mockups
- Decision gate: Stakeholder approval of design

**Build** (Weeks 3-8)
- Outputs: Working software, API integration, mobile app updates
- Decision gate: Feature complete, code review passed

**Test & Launch** (Weeks 9-10)
- Outputs: QA sign-off, UAT completion, production deployment
- Decision gate: All P0/P1 bugs resolved, performance targets met

**Post-launch** (Weeks 11-12)
- Outputs: Adoption metrics, bug fixes, iteration backlog
- Decision gate: Success metrics trending positive`,
		},
		{
			name: "Success Metrics",
			required: true,
			guidance: `Define how success will be measured with a clear table:

| **Goal** | **Metric** |
| --- | --- |
| Goal description | Specific metric with target |

Include measurement approach.`,
			example: `### **Success Metrics**

| **Goal** | **Metric** |
| --- | --- |
| Faster checkout | Avg completion time < 90 seconds |
| Higher conversion | Checkout conversion rate > 70% |
| User satisfaction | Post-checkout NPS > 50 |

**How we'll measure:** Amplitude events + checkout funnel dashboard`,
		},
		{
			name: "Dependencies / Risks",
			required: true,
			guidance: `Identify external dependencies and risks:

- **Dependencies:** Teams, APIs, vendors that must deliver (with owners and timing)
- **Risks:** What could go wrong, plus mitigation strategies`,
			example: `### **Dependencies / Risks**

- **Dependencies:**
  - Payment team: Tokenization API (due Week 4)
  - Platform team: iOS/Android SDK updates (due Week 3)
  - Legal: Privacy policy updates (due Week 2)

- **Risks:**
  - Payment API latency exceeds SLA → Mitigation: Implement caching, async confirmation
  - Low adoption of saved payments → Mitigation: Onboarding prompts, incentives
  - PCI audit delays → Mitigation: Start audit process in Week 1`,
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
- **Ops:** Operations`,
			example: `### **Stakeholders**

- **Business/Sponsor:** Sarah Chen, VP Commerce
- **PM/PO:** Jane Smith, Senior PM
- **Engineering:** Mike Lee, Tech Lead + Mobile Team
- **Design:** Alex Rivera, Senior UX Designer
- **QA:** Jordan Park, QA Lead
- **Ops:** Chris Taylor, Support Manager`,
		},
		{
			name: "Open Questions",
			required: false,
			guidance:
				"List unresolved questions that need stakeholder input or further research.",
			example: `### **Open Questions**

- Should we require re-authentication for purchases over $500?
- What's the retention period for saved payment methods?
- Do we need explicit opt-in for saving payment info?`,
		},
		{
			name: "Release Notes",
			required: false,
			guidance: `Draft release notes in plain language:

What shipped + who it helps + any limitations.`,
			example: `### **Release Notes**

**One-Tap Checkout** - Returning customers can now complete purchases in seconds using saved payment methods. Simply tap "Buy Now" and confirm with Face ID or Touch ID.

Available for iOS and Android. Supports Visa, Mastercard, and American Express.`,
		},
	],

	qualityChecklist: [
		"Header block includes all fields: Title, Client/Team, Sponsor, Owner, Date, Version, Links",
		"Benefit Hypothesis clearly states if/then/because with measurable outcome",
		"Overview covers current state, proposed solution, and expected outcome",
		"In Scope and Out of Scope are clearly separated",
		"Deliverables are categorized by Product, Engineering, Quality, Ops",
		"Plan breaks work into phases with clear decision gates",
		"Success metrics table has specific measurable targets",
		"Dependencies list specific teams/APIs with owners and timing",
		"Risks include mitigation strategies",
		"Stakeholder list is complete with names and roles",
	],

	antiPatterns: [
		"Including Executive Summary section (forbidden)",
		"Including Timeline and Milestones section (use Plan/Phases instead)",
		"Including Budget/Pricing/Investment section (forbidden)",
		"Including ROI Analysis section (forbidden)",
		"Including Appendix section (forbidden)",
		"Including Terms & Conditions section (forbidden)",
		"Vague benefit hypothesis without measurable outcome",
		"Scope that only lists In Scope (missing Out of Scope)",
		"Dependencies without owners or expected dates",
		"Risks listed without mitigation strategies",
	],

	examples: {
		goodBenefitHypothesis: `### **Benefit Hypothesis**

If we deliver **automated order reconciliation**, then **manual processing costs** decrease by **$180K annually** because **4 hours of daily reconciliation is eliminated**.`,

		goodMetric: `| **Goal** | **Metric** |
| --- | --- |
| Faster processing | Order-to-fulfillment time < 2 hours |
| Higher accuracy | Order error rate < 0.5% |
| Cost reduction | Processing cost per order < $0.50 |

**How we'll measure:** Order analytics dashboard + monthly cost reports`,
	},
};
