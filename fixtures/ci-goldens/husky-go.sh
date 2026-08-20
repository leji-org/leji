# >>> leji hooks (managed) >>>
'go' 'tool' 'leji' validate || exit 1
'go' 'tool' 'leji' index --check || {
   echo 'leji: stored index is stale; run `leji index` and stage the result.' >&2
   exit 1
}
# <<< leji hooks (managed) <<<
