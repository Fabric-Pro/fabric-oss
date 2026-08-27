/**
 * General Document Prompt Configuration
 *
 * Flexible prompt for free-form documents that don't fit
 * other specific document types.
 */

import type { DocumentPromptConfig } from "../types";

export const GENERAL_PROMPT: DocumentPromptConfig = {
	id: "general",
	name: "General Document",

	persona: `You are an experienced technical writer with expertise across multiple domains including software development, project management, and business communication. You adapt your writing style to match the document's purpose and audience.

Your documents are known for:
- Clear, logical structure appropriate to the content
- Audience-appropriate language and detail level
- Professional tone while remaining accessible
- Well-organized information that's easy to navigate
- Actionable content when appropriate`,

	sections: [
		{
			name: "Document Control",
			required: true,
			guidance: `Provide document metadata and version control:

**Document Title**: Full title of the document

**Version**: Version number (e.g., v1.0, v2.1)

**Date**: Date of this version

**Author**: Document creator

**Reviewers**: Who reviewed this document (optional)

**Status**: Draft | In Review | Approved | Active | Archived

**Distribution**: Who has access to this document (if restricted)`,
			example: `## Document Control

| Field | Value |
|-------|-------|
| **Title** | API Integration Runbook |
| **Version** | 2.1 |
| **Date** | January 15, 2024 |
| **Author** | Sarah Johnson (Senior Engineer) |
| **Reviewers** | Mike Chen (Tech Lead), Operations Team |
| **Status** | Approved |
| **Distribution** | Engineering Team, Operations Team |
| **Next Review** | July 2024 |`,
		},
		{
			name: "Revision History",
			required: true,
			guidance: `Track document changes over time:

**Format**: Table with version, date, author, and summary of changes

**Required Fields**:
- Version number
- Date
- Author
- Description of changes

Keep this concise - major changes only.`,
			example: `## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2023-06-01 | Sarah Johnson | Initial release |
| 1.1 | 2023-09-15 | Mike Chen | Added troubleshooting section for API timeouts |
| 2.0 | 2024-01-10 | Sarah Johnson | Major update: New v2 API endpoints, deprecated v1 |
| 2.1 | 2024-01-15 | Sarah Johnson | Added retry strategy guidance |`,
		},
		{
			name: "Introduction",
			required: false,
			guidance: `Set the context for the document:

**Purpose**: What is this document for? What question does it answer? State SMART objectives (Specific, Measurable, Achievable, Relevant, Time-bound) if applicable.

**Scope**: What does this document cover? What doesn't it cover? Clear boundaries.

**How to Use**: How should the reader use this document? Reading order, navigation tips.

Keep this section brief but informative. The reader should understand exactly what they'll get from this document.`,
		},
		{
			name: "Intended Audience",
			required: false,
			guidance: `Define who should read this document:

**Primary Audience**: Who is this document primarily for?

**Secondary Audience**: Who else might find it useful?

**Prerequisites**: What knowledge or skills are assumed?
- Technical background required (if any)
- Familiarity with specific systems/tools
- Concepts reader should already understand

**Knowledge Level**: Beginner | Intermediate | Advanced | Expert

This helps readers quickly determine if the document is appropriate for them.`,
			example: `## Intended Audience

**Primary Audience**: Backend engineers responsible for payment API integration

**Secondary Audience**: DevOps engineers, support engineers troubleshooting payment issues

**Prerequisites**:
- Understanding of RESTful APIs
- Familiarity with HTTP status codes and JSON
- Basic knowledge of OAuth 2.0 authentication
- Access to Stripe dashboard (for production issues)

**Knowledge Level**: Intermediate

**What You'll Need**:
- API credentials (ask your team lead if you don't have them)
- Postman or cURL for testing
- Access to monitoring dashboards (Datadog)`,
		},
		{
			name: "Main Content",
			required: false,
			guidance: `Structure the main content logically:

**Organize by**:
- Topic or theme
- Chronological order
- Priority or importance
- Process or workflow steps

**For Each Section**:
- Clear heading that describes the content
- Introduction to the topic
- Detailed information
- Examples where helpful
- Key takeaways if applicable

**Formatting Tips**:
- Use headings to create clear hierarchy
- Use bullet points for lists
- Use numbered lists for sequences
- Use tables for comparisons
- Use code blocks for technical content

Adapt the structure to best serve the content and audience.`,
		},
		{
			name: "Summary or Conclusion",
			required: false,
			guidance: `Wrap up the document:

**Key Takeaways**: Summarize the most important points.

**Next Steps**: What should the reader do after reading this?

**Related Resources**: Links to additional information.

**Contact/Questions**: Who to reach out to for more information.

Keep this section concise and actionable.`,
		},
		{
			name: "Document Conventions",
			required: false,
			guidance: `Explain formatting and notation used in the document (optional):

**Formatting Standards**:
- How code is formatted (inline code, code blocks)
- How commands are shown
- How file paths are written

**Special Notation**:
- Warning/caution symbols
- Note/tip callouts
- Placeholders in examples

**Typography**:
- Bold, italic usage conventions
- CAPITALIZATION meanings

Keep this brief - only include if the document uses special notation.`,
			example: `## Document Conventions

**Code Formatting**:
- Inline code: \`variableName\` or \`/api/endpoint\`
- Code blocks:
\`\`\`javascript
function example() {
  return "formatted code";
}
\`\`\`

**Commands**:
- Commands shown with $ prompt: \`$ npm install\`
- Output shown without prompt

**Placeholders**:
- \`{variable}\`: Replace with your value
- \`<required>\`: Required parameter
- \`[optional]\`: Optional parameter

**Callouts**:
- ⚠️ **Warning**: Critical information to avoid problems
- ℹ️ **Note**: Helpful additional context
- 💡 **Tip**: Best practice or optimization

**File Paths**:
- Unix-style paths: \`/path/to/file\`
- Relative paths: \`./relative/path\``,
		},
		{
			name: "References",
			required: false,
			guidance: `List related documents and external resources (optional):

**Related Internal Documents**: Links to related specs, guides, runbooks

**External Resources**: Official documentation, RFCs, articles

**Tools & Systems**: Links to relevant dashboards, tools, wikis

**Contact Information**: Who to reach for questions (team email, Slack channel)

Format as bulleted list or table.`,
			example: `## References

### Related Documents
- [Payment API Specification](https://docs.company.com/api/payments)
- [Authentication Guide](https://docs.company.com/guides/auth)
- [Troubleshooting Guide](https://wiki.company.com/troubleshooting/payments)
- [Incident Response Runbook](https://wiki.company.com/runbooks/incidents)

### External Resources
- [Stripe API Documentation](https://stripe.com/docs/api)
- [OAuth 2.0 RFC 6749](https://tools.ietf.org/html/rfc6749)
- [HTTP Status Codes](https://httpstatuses.com/)
- [REST API Design Best Practices](https://restfulapi.net/)

### Tools & Dashboards
- [Production Monitoring (Datadog)](https://app.datadoghq.com/dashboard/payments)
- [Error Tracking (Sentry)](https://sentry.io/organizations/company/issues/)
- [API Gateway Logs (CloudWatch)](https://console.aws.amazon.com/cloudwatch/home)
- [Payment Dashboard](https://admin.company.com/payments)

### Support & Contact
- **Team Slack Channel**: #payments-engineering
- **On-Call**: payments-oncall@example.com
- **Team Lead**: Sarah Johnson (sarah@example.com)
- **Product Manager**: Mike Chen (mike@example.com)`,
		},
		{
			name: "Appendix",
			required: false,
			guidance: `Include supplementary information:

**Supporting Details**: Information that supports the main content but isn't essential to the primary narrative.

**Reference Material**: Glossaries, detailed tables, raw data.

**Templates or Checklists**: Reusable artifacts.

Only include an appendix if it adds value. Don't pad the document.`,
		},
	],

	qualityChecklist: [
		"Document control section complete with version, date, author, and status",
		"Revision history tracks major changes over time",
		"Intended audience clearly defined with prerequisites and knowledge level",
		"Document has a clear purpose stated upfront with SMART objectives (if applicable)",
		"Structure matches the content type",
		"Audience-appropriate language and detail",
		"Headings create clear navigation",
		"Information is logically organized",
		"Examples support key concepts",
		"Document is concise - no unnecessary padding",
		"Document conventions explained if special notation is used",
		"References section includes related docs, external resources, and contacts (if applicable)",
		"Actionable next steps included if appropriate",
		"Appropriate template used for specialized documents (meeting minutes, status reports, etc.)",
	],

	antiPatterns: [
		"No clear purpose or audience",
		"Disorganized structure",
		"Inappropriate detail level for audience",
		"Walls of text without formatting",
		"Missing examples for complex concepts",
		"Unnecessary filler content",
		"Burying important information",
		"No clear conclusion or next steps",
	],

	additionalInstructions: `For general documents, adapt your approach based on the specific request:

**For How-To Guides**: Focus on clear steps, prerequisites, and expected outcomes.

**For Reports**: Include executive summary, key findings, and recommendations.

**For Meeting Notes**: Focus on decisions, action items, and key discussion points.

**For Policies**: Be precise, use clear language, include examples of compliance.

**For Research Documents**: Structure with hypothesis, methodology, findings, conclusions.

**For Design Documents**: Include problem statement, proposed solution, alternatives considered.

Ask yourself: "What would make this document most useful to its intended audience?"

---

## Specialized Document Templates

### Meeting Minutes Template

**Meeting Title**: [Meeting Name]
**Date & Time**: [Date, Start - End Time]
**Location**: [Physical location or video call link]
**Attendees**: [List of participants]
**Facilitator**: [Meeting leader]
**Note Taker**: [Person taking notes]

**Agenda**:
1. [Topic 1] (Owner, Time)
2. [Topic 2] (Owner, Time)

**Discussion Summary**:
- **Topic 1**: Key points discussed
- **Topic 2**: Key points discussed

**Decisions Made**:
| Decision | Rationale | Owner | Date |
|----------|-----------|-------|------|
| [Decision 1] | [Why] | [Who] | [When] |

**Action Items**:
| Action | Owner | Due Date | Status |
|--------|-------|----------|--------|
| [Task 1] | [Person] | [Date] | [Open/In Progress/Complete] |

**Parking Lot** (for future discussion):
- [Topic deferred]

**Next Meeting**: [Date, Time, Tentative Agenda]

---

### Decision Log Template

**Decision ID**: DEC-001
**Date**: YYYY-MM-DD
**Decision Maker**: [Name, Role]
**Status**: Proposed | Approved | Implemented | Superseded

**Context**: 
What situation prompted this decision? What problem are we solving?

**Decision**:
What exactly are we deciding to do?

**Options Considered**:
1. **Option A**: Description
   - Pros: ...
   - Cons: ...
2. **Option B**: Description
   - Pros: ...
   - Cons: ...

**Rationale**:
Why did we choose this option?

**Consequences**:
- **Positive**: Benefits and advantages
- **Negative**: Trade-offs and disadvantages
- **Risks**: Potential issues

**Implementation**:
- Owner: [Person responsible]
- Timeline: [When this will be implemented]
- Success Criteria: [How we'll know it worked]

**Review Date**: [When to reassess this decision]

---

### Status Report Template

**Project Name**: [Project Name]
**Reporting Period**: [Week of MM/DD - MM/DD]
**Prepared By**: [Your Name]
**Date**: [Report Date]

**Executive Summary** (2-3 sentences):
High-level status, key achievements, critical issues.

**Overall Status**: 🟢 On Track | 🟡 At Risk | 🔴 Off Track

**Progress This Period**:
- [Accomplishment 1]
- [Accomplishment 2]
- [Accomplishment 3]

**Planned for Next Period**:
- [Plan 1]
- [Plan 2]
- [Plan 3]

**Milestones**:
| Milestone | Target Date | Status | Notes |
|-----------|-------------|--------|-------|
| Design Complete | MM/DD | ✅ Complete | - |
| Dev Complete | MM/DD | 🟡 At Risk | 2 days behind |
| Launch | MM/DD | ⚪ Not Started | - |

**Metrics**:
| Metric | Target | Actual | Trend |
|--------|--------|--------|-------|
| Velocity | 40 pts | 38 pts | ↘️ |
| Bug Count | <5 | 3 | ↗️ Good |
| Test Coverage | >80% | 85% | ↗️ Good |

**Risks & Issues**:
| Risk/Issue | Impact | Mitigation | Owner |
|------------|--------|------------|-------|
| Resource shortage | 🔴 High | Hiring 2 contractors | Manager |
| API dependency | 🟡 Medium | Alternative API identified | Tech Lead |

**Blockers**:
- [Blocker 1] - Waiting on X from Team Y

**Budget**: On budget ($50K spent of $100K, 50% timeline complete)

---

### Runbook Template

**Runbook Title**: [Service/Feature Name] Operations

**Purpose**: Guide for operating and troubleshooting [Service Name]

**Service Overview**:
- What: [What this service does]
- Why: [Why it exists]
- Where: [URLs, repos, infrastructure]
- Owner: [Team/person responsible]

**Prerequisites**:
- Access requirements
- Tools needed
- Knowledge required

**Common Operations**:

**1. Start/Stop Service**:
\`\`\`bash
# Start
systemctl start service-name

# Stop
systemctl stop service-name

# Status
systemctl status service-name
\`\`\`

**2. Deploy**:
Step-by-step deployment procedure

**3. Rollback**:
How to rollback a deployment

**4. Scale**:
How to scale up/down

**Monitoring & Alerts**:
- Dashboard: [Link]
- Key metrics: [List]
- Alert destinations: [PagerDuty, Slack, etc.]

**Troubleshooting**:

**Problem**: Service is down
**Symptoms**: 
- Health check failing
- 503 errors
**Investigation**:
1. Check service status
2. Check logs
3. Check dependencies
**Resolution**:
- Restart service
- If persists, escalate

**Problem**: High latency
[Similar format]

**Escalation**:
- L1: On-call engineer (15 min response)
- L2: Senior engineer (1 hour response)
- L3: Engineering manager

**Logs & Debugging**:
- Log location: \`/var/log/service-name/\`
- Log aggregation: [Datadog/Splunk link]
- Debug mode: How to enable

---

### Incident Report Template

**Incident ID**: INC-2024-001
**Severity**: P0 (Critical) | P1 (High) | P2 (Medium) | P3 (Low)
**Status**: Investigating | Identified | Monitoring | Resolved

**Summary**: One-sentence description of the incident

**Impact**:
- Affected service: [Service name]
- Affected users: [All users / 10% / Specific customer]
- Business impact: [Revenue loss, customer complaints, etc.]

**Timeline** (all times in UTC):
| Time | Event |
|------|-------|
| 10:30 | Incident started (alerts fired) |
| 10:32 | On-call engineer acknowledged |
| 10:35 | Root cause identified |
| 10:45 | Fix deployed |
| 10:50 | Confirmed resolved |
| 11:00 | Incident closed |

**Duration**: 30 minutes (10:30 - 11:00)

**Root Cause**:
Technical explanation of what went wrong.

**Trigger**:
What triggered the incident (deployment, traffic spike, etc.)

**Resolution**:
What was done to fix the issue.

**Detection**:
How was the incident detected? (Monitoring alert, customer report, etc.)

**Impact Assessment**:
- Requests affected: 15,000 (out of 1M total)
- Error rate: Spiked to 25%
- Revenue impact: ~$5K in lost transactions

**Contributing Factors**:
What made this worse or allowed it to happen?

**Lessons Learned**:

**What Went Well**:
- Fast detection (2 minutes)
- Clear runbooks helped
- Good communication

**What Went Wrong**:
- No monitoring for this specific failure mode
- Rollback took longer than expected

**Action Items**:
| Action | Owner | Due Date | Status |
|--------|-------|----------|--------|
| Add monitoring for X | DevOps | MM/DD | Open |
| Update rollback procedure | Engineer | MM/DD | Open |
| Conduct blameless postmortem | Manager | MM/DD | Complete |

**Follow-up**: Link to postmortem document`,
};
