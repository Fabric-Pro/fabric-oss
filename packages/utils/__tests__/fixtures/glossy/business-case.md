## Business Case
Title: Example Onboarding Automation
Owner: TBD
Status: Draft
Decision Needed By: TBD
Links: TBD

---
## 0) Source Index
[S1] Kickoff notes — steering group discussion of onboarding delays
[S2] Operations report — quarterly onboarding cycle-time figures
[S3] Customer survey — onboarding satisfaction results for example.com accounts

---
## 1) Executive Summary (Required)
Decision ask (one line): Approve Pilot (Status: Confirmed; Evidence: [S1] — decision section)
What we're solving (one line): New customer onboarding takes 14 days on average (Status: Confirmed; Evidence: [S2] — cycle-time table)
Proposed approach (1–3 bullets):
- Automate workspace provisioning for new accounts (Status: Directionally Confirmed; Evidence: [S1] — action items, [S3] — survey comments)
- Replace the manual checklist review with guided setup (Status: Assumed; Evidence: n/a)
Expected value (1–3 bullets):
- A 30% efficiency gain in onboarding effort (Status: Assumed; Evidence: n/a)
- Faster first value for new administrators (Status: Directionally Confirmed; Evidence: \[S3\] — free-text answers)
Key risks / unknowns (1–3 bullets):
- Billing integration effort is not yet sized (Status: TBD; Evidence: n/a)

---
## 2) Context & Case for Change (Required)

### 2.1 Problem / Opportunity
Onboarding relies on six manual handoffs between sales and support (Status: Confirmed; Evidence: \[S2\] — process map (page 4))

### 2.2 Who is impacted and why now?
Support leads and new customer administrators carry most of the delay (Status: Confirmed; Evidence: [S1])
Renewal targets for the next fiscal year depend on faster activation (Status: Derived Dependency — needed for the renewal plan; Evidence: [S1] — targets slide)

---
## 3) Options Considered (Required)
Option name: Extend the existing admin console
Summary: Add guided setup and provisioning to the current console (Status: Directionally Confirmed; Evidence: [S1])
Pros / Cons: faster setup, but more console surface to maintain (Status: Directionally Confirmed; Evidence: [S1])
Rough cost/effort band: Medium (Status: Assumed; Evidence: n/a)
Confidence: Directionally Confirmed

Option name: Do nothing
Summary: Keep the manual checklist and accept the current cycle time (Status: Confirmed; Evidence: [S2])
Risks / Constraints: support workload stays high (Status: Confirmed; Evidence: [S2])

---
## 4) Recommended Option (Required)
Recommendation: Extend the existing admin console (Status: Confirmed; Evidence: [S1] — decision section)
What we are explicitly NOT doing (right now): replacing the billing system (Status: Confirmed; Evidence: [S1])

---
## 6) Value Hypothesis & Success Metrics (Required)

### 6.2 Success Metrics
| Goal | Metric | Target | Measurement Method | Owner | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Faster activation | Median onboarding days | 7 days | Operations dashboard | TBD | Confirmed | [S2] |
| Less manual effort | Hours per onboarding | 30% reduction | Time tracking sample | Support lead | Assumed | n/a |
| Higher satisfaction | TBD | TBD | Survey | TBD | TBD | n/a |

---
## 7) Costs & Investment (Include if context supports; otherwise TBD)
TBD — insufficient cost data in sources

---
## 9) Delivery Approach (Lightweight) (Required)
Proposed phases: Discovery, Pilot, Scale (Status: Directionally Confirmed; Evidence: [S1])

```mermaid
flowchart LR
  D[Discovery] --> P[Pilot] --> S[Scale]
```

Major milestones and gates: pilot review after eight weeks (Status: Assumed; Evidence: n/a)

---
## 11) Open Questions (Required)
Q1: Which billing events must provisioning wait for?
Blocks: Feasibility
Why it matters: provisioning order drives the pilot scope
Owner/decider (if known): TBD
Needed by: TBD

---
## 12) Recommendation & Next Step (Required)
Recommended decision: Approve Pilot (Status: Confirmed; Evidence: [S1])
Immediate next steps: confirm the pilot cohort with support leads (Status: Confirmed; Evidence: [S1] — action items)
What artifacts to produce next: a pilot plan (Status: Assumed; Evidence: n/a)
