# Isolation image for running the full dsh-sandbox-linux test suite.
#
# Only OS-level tooling the plugin shells out to lives here (bubblewrap,
# python3). The plugin tree and the harness it imports from are bind-mounted by
# `scripts/test-in-container.sh`, so the image stays small and always tests the
# current working tree.
#
# The base image has no ca-certificates, so the https mirror is fetched with
# peer verification disabled for the bootstrap; the Debian Release signature is
# still checked against the bundled debian-archive-keyring.
FROM node:24-trixie-slim

RUN sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get \
      -o Acquire::https::Verify-Peer=false \
      -o Acquire::https::Verify-Host=false \
      update \
 && apt-get \
      -o Acquire::https::Verify-Peer=false \
      -o Acquire::https::Verify-Host=false \
      install -y --no-install-recommends \
      bubblewrap \
      python3 \
      git \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work
CMD ["/bin/bash"]
