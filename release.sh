#!/bin/sh
# Setzt die Version in app/manifest.json, committet, taggt und pusht.
# Der GitHub-Actions-Workflow "Release" baut danach das .eap und legt den
# GitHub-Release an (Tag und manifest.json müssen übereinstimmen).
# Aufruf: ./release.sh 0.2.4   (oder ./release.sh v0.2.4)
set -e
cd "$(dirname "$0")"

VERSION=${1#v}
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "Aufruf: ./release.sh <major.minor.patch>" >&2; exit 1 ;;
esac
TAG="v$VERSION"

[ -z "$(git status --porcelain)" ] || { echo "Arbeitsverzeichnis ist nicht sauber." >&2; exit 1; }
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG existiert bereits." >&2
  exit 1
fi

sed -i "s/^\( *\)\"version\": \"[0-9.]*\"/\1\"version\": \"$VERSION\"/" app/manifest.json
[ "$(sed -n 's/.*"version": "\([0-9.]*\)".*/\1/p' app/manifest.json | head -1)" = "$VERSION" ] \
  || { echo "Version in app/manifest.json konnte nicht gesetzt werden." >&2; exit 1; }

git commit -qam "Release Micro VMS $VERSION" -- app/manifest.json
git tag -a "$TAG" -m "Micro VMS ACAP $TAG"
git push origin HEAD "$TAG"
