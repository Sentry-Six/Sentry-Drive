#!/usr/bin/env bash
set -euo pipefail

tag=$1
shift
existing=$(gh release view "$tag" --json assets --jq '.assets[].name')

for asset in "$@"; do
  test -f "$asset"
  name=${asset##*/}
  if grep -Fxq -- "$name" <<< "$existing"; then
    # Publishing a prepared draft must not replace its reviewed/signed files.
    echo "Preserving existing release asset: $name"
  else
    # A concurrent upload fails safely instead of overwriting another artifact.
    gh release upload "$tag" "$asset"
  fi
done
