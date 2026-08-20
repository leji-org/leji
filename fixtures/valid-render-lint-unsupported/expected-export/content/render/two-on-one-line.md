<!--
   The ordering exercise: several constructs on one line. Findings are ordered by
   (path, line, rule, construct), so the construct token is the tie-breaker that
   keeps same-line findings deterministic across the three SDKs. Alphabetical
   order of the closed token set is `footnote`, `math-block`, `raw-html`.
-->

# Two constructs on one line

A line with a footnote reference[^a] and inline <b>markup</b> together.

A line with all three: [^b], <i>italic</i>, and $$x + y$$ in one sentence.

[^a]: A definition, so the file also carries a single-construct line.
