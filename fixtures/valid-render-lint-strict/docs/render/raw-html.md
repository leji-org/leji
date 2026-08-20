<!--
   Planted construct: `raw-html`, in both forms the lint recognizes — the
   CommonMark HTML block and inline raw HTML. Comments are the excepted form, so
   this header and the ones below it report nothing.

   A finding is attributed to the construct's opening line, one per (file, line,
   construct), so a multi-line HTML block reports once: at the line that opens it.
-->

# Raw HTML

## Block form

A block-level element on its own line opens an HTML block that runs to the next
blank line:

<div class="callout">
   Raw HTML inside a block. The finding sits on the opening line, not on this one
   and not on the closing tag.
</div>

A second block, to pin that each block reports separately:

<table>
   <tr><td>one</td><td>two</td></tr>
</table>

## Inline form

A paragraph carrying <b>bold</b> markup mid-sentence.

A paragraph with two inline tags, <i>italic</i> and <code>code</code>, which is
still one finding: the line is the unit.

A self-closing tag inline: this sentence carries a break <br /> and then
continues on the next source line.

A closing tag with no opener on its line is still inline raw HTML: </span>
