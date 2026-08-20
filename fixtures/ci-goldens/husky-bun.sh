# >>> leji hooks (managed) >>>
'bun' 'run' 'leji' validate || exit 1
'bun' 'run' 'leji' index --check || {
   echo 'leji: stored index is stale; run `leji index` and stage the result.' >&2
   exit 1
}
# <<< leji hooks (managed) <<<
