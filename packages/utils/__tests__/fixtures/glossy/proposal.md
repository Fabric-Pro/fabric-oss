# Project Proposal: Example Field Service Portal

## 1. Proposal Cover
- **Project:** Example Field Service Portal
- **Client:** Example Org
- **Sponsor:** TBD
- **Delivery Owner:** Delivery Lead (dev@example.com)
- **Date / Version:** 2026-09-01 / v0.3
- **Proposal Type:** Contract Development (SOW-style)
- **Key Links:** PRD | Architecture | Timeline

## 1A. Source Index
- [S1] Discovery workshop notes — transcript — 2026-08-12 — goals and constraints from the sponsor group
- [S2] Current-state process map — doc — 2026-08-20 — dispatcher workflow and pain points
- [S3] Budget guidance — email — 2026-08-22 — spending ceiling for the first phase

## 2. Executive Summary (Approval Section)
- Dispatchers re-key every work order into two systems, adding a day of delay [S2]
- We propose a single portal that routes work orders to field technicians [cite]
- The first release covers intake, dispatch, and technician updates [S1][S2]
- The first phase is capped at 240k **[S3]**
- Top risk: the scheduling system has no public API yet [S1, S2]
- Decision requested: approve Phase 0 Discovery

## 3. Background and Current State
- **Current workflow / system reality:** work orders arrive by email and phone [S2]
- **Constraints:** technicians work offline for most of the day [cite]

## 4. Objectives and Success Metrics

### Objectives
1. Cut the time from request to assignment [S1]
2. Remove duplicate data entry [S2]

### Success Metrics
| Goal | Metric | Target |
|---|---|---|
| Faster dispatch | Time from request to assignment | Under 2 hours [S1] |
| Fewer errors | TBD | TBD |

## 7. Delivery Plan and Milestones
- **Phase 0: Discovery / Alignment** — confirm integrations and data ownership [S1]
- **Phase 1: Build** — intake, dispatch board, technician app [cite]

## 13. Commercial Terms (Contract-Ready)

### Estimate / Budget
- Budget: TBD
- The first phase is fixed at 240k [S3]

## 14. Open Questions / Needed Decisions
- Business: who approves changes to service levels?

## 15. Appendix (Optional)

### Glossary
- **Work order:** a request for on-site service [S2]

### Reference links
- Example design guide — https://example.com/design
