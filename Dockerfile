# Keep the base image literal so Dependabot can detect it.
FROM axisecp/acap-native-sdk:12.11.1-aarch64-ubuntu24.04

# Reine Shell-/Web-App ("architecture": "all") -> ein .eap für armv7hf und aarch64
COPY ./app /opt/app/
WORKDIR /opt/app

# ACAP serves static files with long-lived cache headers, so after an app update
# the browser may reuse style.css/app.js from the previous install. Appending the
# manifest version to every local css/js URL makes an update a new cache entry.
RUN set -e; v=$(sed -n 's/.*"version": "\([0-9.]*\)".*/\1/p' manifest.json | head -1); \
    sed -E -i "s#(href=\"|src=\")([a-z0-9./_-]*\.(css|js))\"#\1\2?v=$v\"#g" html/index.html; \
    grep -q "style.css?v=$v" html/index.html

RUN chmod +x microvms && . /opt/axis/acapsdk/environment-setup* && acap-build ./
