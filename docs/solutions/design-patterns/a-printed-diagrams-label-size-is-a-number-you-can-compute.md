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
  - "Changing how the live document page draws mermaid flowcharts (font, label breaks, direction)"
tags: [proposal-export, pdf, mermaid, beautiful-mermaid, diagrams, print, legibility, svg, fizzy-2946]
audience: engineers working on the Proposal export or on the diagrams generation writes
owner: Fabric platform
---

# A printed diagram's label size is a number you can compute before you look

## Context

A Proposal's PDF prints each mermaid diagram as an SVG shrunk to the text column. A diagram wider than the column is scaled down, and its labels with it. Every check on the data passed: the fence parsed, the SVG rendered, it fit the page. The PDF was still unreadable. A staging export printed a left-to-right chain of generated steps at about 3 pt (Fizzy #2946). After the export started turning such charts top-down (#1390), diagrams stored with one-line labels of 130 characters or more still printed at about 6 pt, which #1399 fixed by breaking long labels.

Both defects could only be seen in the rendered PDF. They could also be predicted from the diagram's size.

## The formula

```text
printed label pt = renderer label px
                   × min(1, print column px / SVG width px, figure height px / SVG height px)
                   × 0.75
```

- **Renderer label px.** beautiful-mermaid draws node labels at 13 px (its `FONT_SIZES.nodeLabel`). Edge labels are 11 px and subgraph headers 12 px.
- **Print column px.** US Letter (8.5 in) less two 0.8 in side margins is 6.9 in. At 96 CSS px per inch, that is **662.4 px**: (12240 − 2 × 1152) / 15 twips.
- **Figure height px.** The DOCX writer shrinks a picture taller than the portrait text height less an inch for its caption (`MAX_IMAGE_HEIGHT`): 11 in less the 0.85 in top and 0.9 in bottom margins, less 1 in, is 8.25 in, **792 px**. The PDF does not shrink a tall figure, but its text area is only 888 px tall, so a figure past that does not fit a page. 792 px is the limit that binds both.
- **0.75** converts CSS px to pt (72 / 96).
- **The floor** is 9 pt. A diagram that fits both limits prints its labels at 13 × 0.75 = **9.75 pt**. Any diagram wider than 662.4 × 9.75 / 9 ≈ 718 px, or taller than 792 × 9.75 / 9 = 858 px, prints below the floor.
- **SVG width and height** are the size the engine lays the diagram out at. The export and the live page both pass it an 8 px canvas margin (`DIAGRAM_CANVAS_PADDING_PX`) instead of its default 40 px, so a flowchart or state diagram is up to 64 px narrower and shorter than the engine's default drawing. It is "up to" because the engine's own clamp on how far an edge reaches still uses the default 40 px. Every size below is measured with the 8 px margin.

In code, `printedNodeLabelPt({ width, height })` in `@repo/utils/proposal-artifact/diagram-label-wrap` computes the formula. That module cannot import the Word writer's `build-docx/styles.ts`, so it restates the page geometry, and `print-column-parity.test.ts` pins it there: `PRINT_COLUMN_PX` to `PORTRAIT_TEXT_WIDTH / TWIPS_PER_PIXEL` and `PRINT_FIGURE_MAX_HEIGHT_PX` to `MAX_IMAGE_HEIGHT / TWIPS_PER_PIXEL`.

A left-to-right chain of nodes whose labels are whole sentences is several thousand pixels wide and prints at roughly 1.6 to 5 pt. One stored diagram, measured at each step of the export:

| Step | SVG size | Printed labels |
|---|---|---|
| As written, `flowchart LR` | 2314 × 74 px | 2.79 pt |
| Labels of 40 characters or more broken, still `LR` | 989 × 154 px | 6.53 pt |
| Broken, turned top-down | 232 × 510 px | 9.75 pt |
| As written, turned top-down | 948 × 311 px | 6.81 pt |

The export lays out the first two rows and keeps the second, whose labels print larger. It is below the floor, so the export turns both copies top-down and keeps the broken one, whose labels print larger. Recompute any row as 13 × min(1, 662.4 / width, 792 / height) × 0.75. The four-step sentence chain in `render-diagrams.test.ts` lays out at about 1781 × 74 px left to right as written (3.6 pt). With its four labels of 40 characters or more broken, it lays out at about 1005 × 104 px left to right (6.4 pt) and 253 × 460 px top-down (9.75 pt).

Height matters for tall diagrams. Breaking labels makes a diagram narrower but taller. An eight-step top-down chain of 73-character labels lays out at 487 × 650 px as written (9.75 pt), but at 229 × 1053 px with its labels broken (7.33 pt), so the copy as written is kept.

The same holds once a diagram is turned. An eight-step left-to-right chain of 40- to 55-character labels prints larger sideways with its labels broken: 2023 × 91 px (3.19 pt) against 3195 × 74 px (2.02 pt). Turned top-down, though, the broken copy is 245 × 918 px (8.42 pt) and the copy as written is 384 × 650 px (9.75 pt), so the copy as written, turned, is kept. The six-item timeline in the Glossy layout is 251 × 984 px broken and turned (7.84 pt) and 775 × 481 px turned as written (8.33 pt). The export keeps the second, still below the floor, and warns.

## What the export does

The export and the live page share one module, `@repo/utils/proposal-artifact/diagram-label-wrap`: the helpers below, the measure and its limits (`printedNodeLabelPt`, `PRINT_COLUMN_PX`, `PRINT_FIGURE_MAX_HEIGHT_PX`, `PRINT_LABEL_FLOOR_PT`), the 40-character pass (`ALWAYS_WRAPPED_LABEL_CHARS`) and the 8 px canvas margin (`DIAGRAM_CANVAS_PADDING_PX`). The labels are found with the same node patterns beautiful-mermaid's parser uses, so the patterns must be checked again after an engine upgrade.

`packages/temporal/src/activities/proposal-export/render-diagrams.ts` applies the formula to every flowchart and state diagram. Other kinds (charts, sequence, class, ER) size their text by rules of their own and are not measured. `renderOne`:

1. **Chooses between the copy as written and one with labels of 40 characters or more broken.** The export lays out the copy as written. When `wrapFlowchartNodeLabels` with `minChars: ALWAYS_WRAPPED_LABEL_CHARS` changes anything, it lays out that copy too. That copy breaks each such one-line node label: the title before a ` — `/` – `/` - ` dash, then a trailing parenthesis, then at words, up to about 30 characters a line. Labels that already have line breaks or inline formatting are left as written. No word is cut or dropped. The copy whose labels print larger is kept. On a tie the broken copy is kept, because its labels stay inside their boxes. A copy the engine refuses drops out. The steps below start from the copy kept.
2. **Re-lays it top-down.** If the graph is below the floor, `turnFlowchartTopDown` changes an `LR`/`RL` header to `TD` in the copy only. The fence in the document is untouched. When the broken copy was kept, the copy as written is turned too, because broken labels make a turned diagram taller and a tall one prints smaller. The render whose labels print larger is kept; the broken one wins a tie.
3. **Breaks the remaining long labels.** If the diagram is still below the floor, `wrapFlowchartNodeLabels` without `minChars` breaks every one-line node label longer than one wrapped line, the same way. The larger render wins again.
4. **Warns.** A diagram still below the floor prints as it is and counts toward one `DIAGRAM_BELOW_PRINT_FLOOR` export warning. The download menu shows it as `exportWarningDiagramBelowPrintFloor` (`DocumentDownloadDropdown.tsx`).

The live page draws its own copy the same way. `drawDiagram` in `apps/web/modules/saas/projects/lib/tiptap-mermaid-extension.tsx` draws with the same canvas margin:

- **A client-document Proposal's page** makes the export's choice and follows its floor rule. It measures each drawing's width and height against the print column and the figure height, so the page shows the layout the PDF prints.
- **Other documents** always draw the copy with labels of 40 characters or more broken (see the next section for why), since height does not matter on screen. They keep the direction their author wrote.

Only the drawn copy changes, never the fence. After that, `mermaid-diagram-sizing.ts` shrinks a diagram only as far as its smallest label stays at `MIN_DIAGRAM_LABEL_PX = 12`, and a wider one scrolls sideways in its container.

The generation side helps too. Proposal diagrams the visuals step writes use a short title plus at most one short detail per node, and timelines are drawn top-down. Diagrams stored before that change are why the export still has to wrap.

## Text width is estimated, not measured

beautiful-mermaid sizes a node box from `measureTextWidth`: a per-character width table (`getCharWidth`) × font size × a weight ratio of 0.54 to 0.60. It never measures the font that is printed. The export prints in Inter, which ran wider than the estimate in the PDFs we reviewed, so a long label could spill past its box. Wrapping shortens each line and makes the spill smaller. Treat the SVG width the renderer reports as a good estimate of size, not a guarantee that the text fits its shape.

On the live page the font is Inter at 500 weight and 13 px. Measured in the browser against the boxes the engine drew, the estimate runs short by:

- about 5 to 9% for plain prose (0.3 to 0.5 px a character);
- 13 to 30% for text dense in narrow letters and dashes, up to about 1 px a character, such as "implementation — implementation of the agreed pilot scope" (57 characters, estimated at 326 px, drawn 370 px wide in a 366 px box);
- almost nothing for capitals.

Measured one glyph at a time, the em dash is 5.5 px wider than its estimate. Lower-case m is 2.6 px wider, the hyphen 2.2, w 1.8, and f and t about 1.4. Narrow i and l are close to their estimates (0.24 px), and r, s, E and L are drawn narrower than estimated.

A box gives its label 20 px of padding on each side, so a one-line label spills once that shortfall passes 40 px. Prose would need 80 characters or more for that; the longest prose label measured, 54 characters, still had 8.8 px to spare on each side. Text dense in narrow letters and dashes, at up to about 1 px a character, reaches it from about 41 characters. The first such label seen to spill had 44.

The threshold rests on that kind of text. The page, the export and the browser download break labels from 40 characters. Among the narrow-letter labels measured, every one of 39 characters or fewer stayed inside its box with at least 1.1 px to spare on each side. The browser download draws in Helvetica, which is 6 to 11% narrower than Inter for lower-case text, so its labels have more room.

Text dense in m, w and hyphens with an em dash runs further short, at 1 to 1.4 px a character. "momentum — minimum-time multi-team flow" (39 characters) spills by 6 px a side, and a 30-character line of the same text by about 1 px. No character count keeps such text inside its box, so a label like that can still spill.

The print fonts are Inter 4.1 at 400, 600, 700 and 800, with no 500. Print therefore draws node labels in Inter Regular, 1 to 4 px narrower a label than on the page, which only adds room.

The 8 px canvas margin does not change any of this: it is the space around the whole drawing, while the 20 px is inside each box.

The height-aware choice has a cost. When breaking would make a diagram taller than a printed figure may be, the PDF, the DOCX and a Proposal's page keep its long labels on one line. A one-line label can then reach past the edge of its box: from about 44 characters for text dense in narrow letters and dashes, and from about 30 for text dense in m, w and hyphens. Prose labels up to the 55 characters measured stayed inside. Labels that print too small to read would be worse. The engine also writes its `font` option inside quotes (`font-family: '<font>', system-ui`). The page used to pass a whole font stack there, which no family matches, so the text was drawn in system-ui. It now passes the single family `Inter`, the font the width table is tuned for.

## The lesson: judge the rendered PDF, not the data

The 3 pt chart passed every data-level assertion. Before saying an export "works", open the PDF and look at the diagrams at print size. Better still, compute the printed size from the SVG's width and height, which turns "it looks small" into a number a test can assert.

## How to test

`packages/temporal/src/activities/proposal-export/__tests__/render-diagrams.test.ts`:

- "the print legibility floor (Fizzy #2946)": the print column equals (8.5 − 2 × 0.8) × 96 and prints at 9.75 pt; a sideways chain of sentence labels is laid out top-down once and prints at 9 pt or more; a label too long even top-down is kept sideways once broken and prints at 9 pt or more; a sideways pair of 70-character labels stays sideways with its labels broken, as the live page draws it; a 57-character label dense in narrow letters is broken even in a diagram the floor rule turns; a sideways chain of eight 40- to 55-character labels prints top-down as written, which prints larger than its broken copy turned; labels under 40 characters are broken only once top-down is still below the floor; a broken copy the engine refuses drops out; a tall top-down chain of 73-character labels prints as written, and a shorter one whose two copies tie keeps the broken one; the better render is kept and the warning raised when even broken labels are too wide; a figure shrunk below the floor by its height warns, and so does one whose kept broken copy is still too wide; a top-down diagram too wide to turn still warns.
- "long node labels broken for print (Fizzy #2946)": labels of 130 characters or more print at 9 pt or more with every word kept; labels with existing breaks are left alone; every common node shape is handled, quoted or not; six-item timelines and flows reach the floor; the same timeline in the Glossy layout prints larger turned as written than broken and turned, still below the floor, and warns.

`print-column-parity.test.ts` checks that the shared print column is the Word writer's text width, that the figure height is its tallest picture and shorter than the page's 888 px text area, and that the export measures with the shared values. On the live side, `tiptap-mermaid-label-legibility.test.tsx` draws the same 70-character pair sideways with its labels broken and the 8 px margin. It also draws the tall chain as written on a Proposal's page and broken on any other page, and the eight-step sideways chain top-down as written on a Proposal's page. It breaks the 57-character label on both pages, and `markdown-to-document-mermaid-labels.test.ts` breaks it in the browser download.

These tests lay out with the real renderer and measure the SVG's `viewBox` width and height. Keep it that way: a mocked width cannot catch a layout that grew.

## Related

- [a-react-node-view-without-node-view-content-shows-its-nodes-text.md](../ui-bugs/a-react-node-view-without-node-view-content-shows-its-nodes-text.md): the same diagrams on the live page.
- [identity-inside-text-that-writers-replace-wholesale.md](../architecture-patterns/identity-inside-text-that-writers-replace-wholesale.md): the marker and caption `%%` lines a diagram carries, which the export strips from its copy before layout.
