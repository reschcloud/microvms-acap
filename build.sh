#!/bin/sh
# Baut das .eap-Paket mit dem offiziellen ACAP Native SDK Container
# und kopiert es nach ./build/
set -e
cd "$(dirname "$0")"
docker build --tag microvms-acap-build .
rm -rf build
CID=$(docker create microvms-acap-build)
docker cp "$CID":/opt/app ./build
docker rm "$CID" >/dev/null
ls -1 build/*.eap
