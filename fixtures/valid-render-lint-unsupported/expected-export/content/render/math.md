<!--
   Planted construct: `math-block`, the paired `$$` form. The lint requires an
   open and a close: a lone `$$` is prose, pinned as a negative in negatives.md.
   Inline `$` is deliberately not linted, so a currency amount stays quiet.
-->

# Math blocks

A display block, opened and closed on their own lines:

$$
a^2 + b^2 = c^2
$$

The finding sits on the opening delimiter's line, so the block above reports
once.

A pair that opens and closes on one line: $$e = mc^2$$ inside a sentence.

A second display block, to pin that each pair reports separately:

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

An amount of $5 and a variable named $path are prose: a single `$` is outside the
lint's closed token set, by design.
