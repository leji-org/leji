# >>> leji hooks (managed) >>>
'npx' '--no-install' '@leji-org/leji' validate || exit 1
'npx' '--no-install' '@leji-org/leji' index --check || {
   echo 'leji: stored index is stale; run `leji index` and stage the result.' >&2
   exit 1
}
# <<< leji hooks (managed) <<<
