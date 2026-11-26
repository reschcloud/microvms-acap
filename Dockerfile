ARG ARCH=aarch64
ARG VERSION=12.11.0
ARG UBUNTU_VERSION=24.04
ARG REPO=axisecp
ARG SDK=acap-native-sdk

FROM ${REPO}/${SDK}:${VERSION}-${ARCH}-ubuntu${UBUNTU_VERSION}

# Reine Shell-/Web-App ("architecture": "all") -> ein .eap für armv7hf und aarch64
COPY ./app /opt/app/
WORKDIR /opt/app
RUN chmod +x microvms && . /opt/axis/acapsdk/environment-setup* && acap-build ./
