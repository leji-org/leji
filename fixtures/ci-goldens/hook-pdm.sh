#!/bin/sh
# leji pre-commit (managed)
# Validate the context layer and refuse a commit that would leave the stored
# index stale. Local mirror of the CI gate; delete this file to opt out.
'pdm' 'run' 'leji' validate || exit 1
'pdm' 'run' 'leji' index --check || {
   echo 'leji: stored index is stale; run `leji index` and stage the result.' >&2
   exit 1
}
