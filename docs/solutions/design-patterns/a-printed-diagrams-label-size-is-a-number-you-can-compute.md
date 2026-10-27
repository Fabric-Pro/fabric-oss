---
title: "A printed diagram's label size is a number you can compute before you look"
date: 2026-10-27
category: design-patterns
module: proposal export diagrams
problem_type: design_pattern
component: background_job
severity: medium
applies_when:
  - "Changing how the PDF or DOCX export draws, sizes or lays out mermaid diagrams"
  - "Changing how generated diagrams are written (label length, direction, node count) for documents that are printed"
  - "Deciding whether a diagram is readable on paper, or reviewing an export by its data instead of its output"
  - "Changing the page size or the margins of the print layout"
tags: [proposal-export, pdf, mermaid, beautiful-mermaid, diagrams, print, legibility, svg, fizzy-2946]
audience: engineers working on the Proposal export or on the diagrams generation writes
owner: Fabric platform
---

# A printed diagram's label size is a number you can compute before you look

## Context

A Proposal's PDF prints each mermaid diagram as an SVG shrunk to the text column. A diagram wider than the column is scaled down, and its labels with it. Every check on the data passed: the fence parsed, the SVG rendered, it fit the page. The PDF was still unreadable. A staging export printed a left-to-right chain of generated steps at about 3 pt (Fizzy #2946). After the export started turning such charts top-down (#1390), diagrams stored with one-line labels of 130 characters or more still printed at about 6 pt, which #1399 fixed by breaking long labels.

Both defects could only be seen in the rendered PDF. They could also be predicted from one number.

## The formula

```text
printed label pt = renderer label px × min(1, print column px / SVG width px) × 0.75
```

- **Renderer label px.** beautiful-mermaid draws node labels at 13 px (its `FONT_SIZES.nodeLabel`). Edge labels are 11 px and subgraph headers 12 px.
- **Print column px.** US Letter (8.5 in) less two 0.8 in side margins is 6.9 in. At 96 CSS px per inch, that is **662.4 px**. In code: `PRINT_COLUMN_PX = PORTRAIT_TEXT_WIDTH / TWIPS_PER_PIXEL` = (12240 − 2 × 1152) / 15 twips.
- **0.75** converts CSS px to pt (72 / 96).
- **The floor** is 9 pt. A diagram no wider than the column prints its labels at 13 × 0.75 = **9.75 pt**. Any diagram wider than 662.4 × 9.75 / 9 ≈ 718 px prints below the floor.

A left-to-right chain of nodes whose labels are whole sentences is several thousand pixels wide and prints at roughly 1.6 to 5 pt. One stored diagram, measured at each step of the export:

| Step | SVG width | Printed labels |
|---|---|---|
| As written, `flowchart LR` | 4041 px | 1.60 pt |
| Turned top-down | 1062 px | 6.08 pt |
| Long labels broken into lines | 313 px | 9.75 pt |

Recompute any row as 13 × min(1, 662.4 / width) × 0.75. The four-step sentence chain in `render-diagrams.test.ts` lays out at about 1845 px left to right (3.5 pt) and at about 544 px top-down (9.75 pt).

## What the export does

`packages/temporal/src/activities/proposal-export/render-diagrams.ts` applies the formula (`printedNodeLabelPt`, `PRINT_COLUMN_PX`, `PRINT_LABEL_FLOOR_PT`) to every flowchart and state diagram. Other kinds (charts, sequence, class, ER) size their text by rules of their own and are not measured. For a graph below the floor, `renderOne`:

1. **Re-lays it top-down.** `turnTopDown` changes an `LR`/`RL` header to `TD` in the export's copy only. The fence in the document is untouched. The render whose labels print larger is kept.
2. **Breaks long labels.** If the diagram is still below the floor, `wrapNodeLabels` breaks each long one-line node label in the copy: the title before a ` — `/` – `/` - ` dash, then a trailing parenthesis, then at words, up to about 30 characters a line (`WRAPPED_LABEL_LINE_CHARS`). Labels that already have line breaks or inline formatting are left as written. It finds labels with the same node patterns beautiful-mermaid's parser uses, so the patterns must be checked again after an engine upgrade. No word is cut or dropped. The larger render wins again.
3. **Warns.** A diagram still below the floor prints as it is and counts toward one `DIAGRAM_BELOW_PRINT_FLOOR` export warning. The download menu shows it as `exportWarningDiagramBelowPrintFloor` (`DocumentDownloadDropdown.tsx`).

The live page uses a different rule. On a client-document Proposal's page, `apps/web/modules/saas/projects/lib/mermaid-diagram-sizing.ts` shrinks a diagram only as far as its smallest label stays at `MIN_DIAGRAM_LABEL_PX = 12`. A diagram that would need more than that keeps the width and scrolls sideways in its container. The page can scroll and paper cannot, so the export has to change the layout instead.

The generation side helps too. Proposal diagrams the visuals step writes use a short title plus at most one short detail per node, and timelines are drawn top-down. Diagrams stored before that change are why the export still has to wrap.

## Text width is estimated, not measured

beautiful-mermaid sizes a node box from `measureTextWidth`: a per-character width table (`getCharWidth`) × font size × a weight ratio of 0.54 to 0.60. It never measures the font that is printed. The export prints in Inter, which ran wider than the estimate in the PDFs we reviewed, so a long label could spill past its box. Wrapping shortens each line and makes the spill smaller. Treat the SVG width the renderer reports as a good estimate of size, not a guarantee that the text fits its shape.

## The lesson: judge the rendered PDF, not the data

The 3 pt chart passed every data-level assertion. Before saying an export "works", open the PDF and look at the diagrams at print size. Better still, compute the printed size from the SVG width, which turns "it looks small" into a number a test can assert.

## How to test

`packages/temporal/src/activities/proposal-export/__tests__/render-diagrams.test.ts`:

- "the print legibility floor (Fizzy #2946)": the print column equals (8.5 − 2 × 0.8) × 96 and prints at 9.75 pt; a sideways chain of sentence labels is laid out top-down once and prints at 9 pt or more; a label too long even top-down is broken and prints at 9 pt or more; the better render is kept and the warning raised when even broken labels are too wide; a top-down diagram too wide to turn still warns.
- "long node labels broken for print (Fizzy #2946)": labels of 130 characters or more print at 9 pt or more with every word kept; labels with existing breaks are left alone; every common node shape is handled, quoted or not; six-item timelines and flows reach the floor.

These tests lay out with the real renderer and measure the SVG's `viewBox` width. Keep it that way: a mocked width cannot catch a layout that grew.

## Related

- [a-react-node-view-without-node-view-content-shows-its-nodes-text.md](../ui-bugs/a-react-node-view-without-node-view-content-shows-its-nodes-text.md): the same diagrams on the live page.
- [identity-inside-text-that-writers-replace-wholesale.md](../architecture-patterns/identity-inside-text-that-writers-replace-wholesale.md): the marker and caption `%%` lines a diagram carries, which the export strips from its copy before layout.
