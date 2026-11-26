# Keep the base image literal so Dependabot can detect it.
FROM axisecp/acap-native-sdk:12.11.0-aarch64-ubuntu24.04

# Reine Shell-/Web-App ("architecture": "all") -> ein .eap für armv7hf und aarch64
COPY ./app /opt/app/
WORKDIR /opt/app
RUN chmod +x microvms && . /opt/axis/acapsdk/environment-setup* && acap-build ./
