<!--
   Planted construct: `footnote`, in both forms the lint recognizes — the inline
   reference and the definition. Footnote syntax is not CommonMark and not GFM
   core, so renderers disagree about it: some render a linked marker and a notes
   section, others show the brackets verbatim.
-->

# Footnotes

A paragraph carrying a footnote reference[^one] mid-sentence.

[^one]: The matching definition, which is the second form the lint recognizes.

A paragraph with two references on one line, [^two] and [^three], which is one
finding: the line is the unit.

[^two]: The second definition.

[^three]: The third definition, whose text wraps in the source; the finding stays
on the line that opens the definition.
