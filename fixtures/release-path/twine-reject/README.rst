Deliberately invalid reStructuredText
=====================================

`this inline literal is never closed, so docutils refuses the document

.. an-unknown-directive::

   and the reference below has no target

`missing target`_
