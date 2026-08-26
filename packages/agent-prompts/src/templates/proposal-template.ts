/**
 * Project Proposal Template Constants
 *
 * PM Standard v2 Proposal format enforcement
 *
 * CRITICAL: This file enforces strict template compliance for proposals.
 * The forbidden sections list must be comprehensive to prevent the LLM
 * from copying RAG context structure instead of following the template.
 */

/**
 * The exact template structure for a PM Standard v2 Proposal
 */
export const PROPOSAL_TEMPLATE = `### **Project Proposal**

**Title:** [Project Name]

**Client/Team:** [Client or Team Name]

**Sponsor:** [Sponsor Name]

**Owner:** [Owner Name]

**Date:** [Date]

**Version:** [Version number]

**Links:** PRD · Timeline · Budget (if any) · Architecture (if any)

---

### **Benefit Hypothesis**

If we deliver **[solution]**, then **[impact]** improves by **[metric]** because **[reason]**.

### **Overview**

- **Current state:** What exists today and what's painful.
- **Proposed solution:** What we'll change/build at a high level.
- **Outcome:** What success looks like.

### **Scope**

### **In Scope**
- [Item 1]
- [Item 2]

### **Out of Scope**
- [Item 1]
- [Item 2]

### **Deliverables**

- **Product:** PRD, flows, wireframes, decisions
- **Engineering:** services, integrations, automation, APIs
- **Quality:** test plan, QA pass, release checklist
- **Ops:** monitoring, alerts, runbook (if needed)

### **Plan (Phases)**

**Discovery:** outputs + decision gate

**Build:** outputs + decision gate

**Test & Launch:** outputs + decision gate

**Post-launch:** monitoring + iteration plan

### **Success Metrics**

| **Goal** | **Metric** |
| --- | --- |
| [Goal 1] | [Metric 1] |
| [Goal 2] | [Metric 2] |

**How we'll measure:** [measurement approach]

### **Dependencies / Risks**

- **Dependencies:** access, data, teams, vendors
- **Risks:** likelihood/impact + mitigation

### **Stakeholders**

- **Business/Sponsor:** [Name]
- **PM/PO:** [Name]
- **Engineering:** [Name]
- **Design:** [Name]
- **QA:** [Name]
- **Ops:** [Name]

### **Open Questions**

- [Question 1]
- [Question 2]

### **Release Notes**

Plain language summary of what's delivered.`;

/**
 * Proposal forbidden sections (sections that should NOT appear in a proposal)
 * This list MUST be comprehensive to prevent RAG context structure from being copied
 *
 * Categories:
 * 1. Executive/Summary sections
 * 2. Problem/Solution sections (use Overview instead)
 * 3. Architecture/Technical sections (keep brief in Deliverables)
 * 4. Timeline/Roadmap sections (use Plan/Phases instead)
 * 5. Budget/Financial sections
 * 6. Appendix sections
 * 7. Legal/Contract sections
 * 8. Document structure sections
 * 9. Other enterprise template patterns
 */
export const PROPOSAL_FORBIDDEN_SECTIONS = [
	// 1. Executive/Summary sections
	"Executive Summary",
	"Summary",
	"Conclusion",
	"Key Highlights",
	"Document Overview",

	// 2. Problem/Solution sections (use Overview instead)
	"Problem Statement",
	"Problem Statement and Business Value",
	"Business Value",
	"Value Proposition",
	"Strategic Objectives",
	"Objectives",
	"Objectives and Success Metrics",
	"Goals and Objectives",
	"Goals and Success Metrics",
	"Proposed Solution Overview",
	"Solution Overview",
	"Solution Description",
	"Solution Summary",

	// 3. Architecture/Technical sections (keep brief in Deliverables)
	"Technical Architecture",
	"System Architecture",
	"System Architecture and Data Flows",
	"Architecture Overview",
	"Data Architecture",
	"Data Models",
	"Data Models and Infrastructure",
	"Core Data Models",
	"Database Schema",
	"Infrastructure",
	"Core Modules",
	"Core Modules and Features",
	"Features and Modules",
	"Module Overview",
	"Data Ingestion",
	"Data Ingestion, Storage, and Processing",
	"Storage and Processing",
	"Data Flows",
	"Data Processing",
	"API Strategy",
	"API Design",
	"Integration Points",
	"Integration, API Strategy, and Data Exchange",
	"Data Exchange",
	"Non-Functional Requirements",
	"Non-Functional Requirements: Reliability, Performance, Security",
	"Technical Requirements",
	"System Components",

	// 4. Timeline/Roadmap sections (use Plan/Phases instead)
	"Timeline",
	"Timeline and Milestones",
	"Project Timeline",
	"Milestones",
	"Roadmap",
	"Roadmap, Milestones, and Delivery Phases",
	"Delivery Phases",
	"Implementation Plan",
	"Implementation Timeline",
	"Project Schedule",
	"Phase Overview",
	"Next Steps",
	"Next Steps and Approvals",

	// 5. Budget/Financial sections
	"Budget",
	"Budget Breakdown",
	"Budget and Resources",
	"Budget, Resources, and Financial Model",
	"Budget and Resource Plan",
	"Resource Plan",
	"Resources",
	"Investment",
	"Pricing",
	"Cost Estimate",
	"Cost Analysis",
	"Financial Model",
	"Financial Overview",
	"ROI Analysis",
	"Return on Investment",
	"Cost-Benefit Analysis",

	// 6. Appendix sections
	"Appendix",
	"Appendices",
	"Appendix A",
	"Appendix B",
	"Appendix C",
	"Appendix D",
	"Appendix: Terminology",
	"Appendix: Terminology and Acronyms",
	"Terminology",
	"Terminology and Acronyms",
	"Acronyms",
	"Glossary",
	"References",

	// 7. Legal/Contract sections
	"Terms & Conditions",
	"Terms and Conditions",
	"Payment Terms",
	"Legal Terms",
	"Contractual Terms",
	"Acceptance Criteria",
	"Sign-off",
	"Document Sign-off",
	"Approval",
	"Approvals",

	// 8. Document structure sections
	"Table of Contents",
	"TOC",
	"Document Structure",
	"About This Document",

	// 9. Other enterprise template patterns
	"Assumptions and Dependencies",
	"Assumptions",
	"Assumptions, Constraints, and Open Questions",
	"Constraints",
	"Governance",
	"Change Management",
	"Adoption, Change Management, and Training",
	"Adoption",
	"Training",
	"Risk Management",
	"Risks, Mitigations, and Dependencies",
	"Organizational Roles",
	"Stakeholders, Roles, and Governance",
	"Company Overview",
	"About Us",
	"Vendor Overview",
	"Team Overview",
	"User Stories",
	"Use Cases",
	"Security, Privacy, and Compliance",
	"Security Overview",
	"Compliance",
	"Privacy",
	"Deployment, Operations, and Support",
	"Deployment",
	"Operations",
	"Support",
	"Operational Readiness",
	"Support Model",
] as const;

/**
 * Format forbidden sections for prompt
 */
export function formatProposalForbiddenSections(): string {
	return PROPOSAL_FORBIDDEN_SECTIONS.map((section) => `- "${section}"`).join(
		"\n",
	);
}

/**
 * Get Proposal override instructions for the prompt builder
 *
 * CRITICAL: This must be placed at the VERY BEGINNING of the prompt
 * to ensure the LLM follows the template instead of RAG context structure
 */
export function getProposalOverrideInstructions(): string {
	return `# 🛑 CRITICAL: YOUR FIRST LINE MUST BE "### **Project Proposal**"

**YOU MUST USE THE PM STANDARD V2 PROPOSAL TEMPLATE. NO EXCEPTIONS.**

## MANDATORY FIRST OUTPUT

Your response MUST start with EXACTLY this (each field on its own line):

\`\`\`
### **Project Proposal**

**Title:** [Project Name]

**Client/Team:** [Client/Team Name]

**Sponsor:** [Sponsor Name]

**Owner:** [Owner Name]

**Date:** [Date]

**Version:** 1.0

**Links:** PRD · Timeline · Budget (if any) · Architecture (if any)
\`\`\`

## MANDATORY SECTIONS (in this exact order)

After the header block, include ONLY these sections:

1. \`### **Benefit Hypothesis**\` - "If we deliver [solution], then [impact] improves by [metric] because [reason]"
2. \`### **Overview**\` - Current state, Proposed solution, Outcome (as bullet points)
3. \`### **Scope**\` with \`### **In Scope**\` and \`### **Out of Scope**\` subsections
4. \`### **Deliverables**\` - Product, Engineering, Quality, Ops categories
5. \`### **Plan (Phases)**\` - Discovery, Build, Test & Launch, Post-launch (each with outputs + decision gate)
6. \`### **Success Metrics**\` - Goal/Metric TABLE format
7. \`### **Dependencies / Risks**\` - Dependencies and Risks bullet groups
8. \`### **Stakeholders**\` - All roles with names
9. \`### **Open Questions**\` - Unresolved items
10. \`### **Release Notes**\` - Plain language summary

## 🚫 FORBIDDEN - INSTANT FAILURE IF YOU USE ANY OF THESE:

**DO NOT create ANY of these sections:**
- Executive Summary
- Table of Contents
- Problem Statement / Business Value
- Objectives and Success Metrics (use Success Metrics table only)
- Proposed Solution Overview (use Overview instead)
- System Architecture / Data Flows / Data Models
- Core Modules / Features / Technical Architecture
- Timeline / Milestones / Roadmap (use Plan/Phases instead)
- Budget / Resources / Financial Model / ROI
- Appendix / Terminology / Glossary
- Terms & Conditions / Approvals / Sign-off
- Assumptions / Constraints (use Dependencies/Risks)
- Non-Functional Requirements (put in Deliverables)
- ANY numbered sections like "1. Overview", "2. Goals"

**DO NOT use these patterns:**
- Numbered section headers (1., 2., 3.)
- Table of Contents
- "Prepared for:" / "Prepared by:" header format
- Document approval/sign-off sections
- Any section not in the mandatory list above

## ⚠️ RAG CONTEXT WARNING

If you receive reference context/documents, extract their CONTENT ONLY.
DO NOT copy their STRUCTURE or SECTION NAMES.
Your output MUST follow the PM Standard v2 template above, regardless of how the reference documents are structured.

**If you create any forbidden sections, you have FAILED the task.**

---

## EXACT TEMPLATE TO FOLLOW:

${PROPOSAL_TEMPLATE}

---

**START YOUR RESPONSE WITH: ### **Project Proposal****`;
}
