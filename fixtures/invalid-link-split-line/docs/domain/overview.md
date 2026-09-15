# Overview

A link whose bracket and parenthesis are split across a line break is not a
link, so a missing target there is not a finding:

[the split form]
(missing-split.md)

The same target on one line is a link, and is the one finding this fixture
expects: [the one-line form](missing-split.md).
