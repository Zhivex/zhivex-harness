# syntax=docker/dockerfile:1.7

# The digest is the immutable Node 24 Bookworm Slim manifest used by the
# benchmark. Refresh it deliberately together with the lock file and docs.
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

LABEL org.opencontainers.image.title="Zhivex Time-to-Safe-Fix benchmark"
LABEL org.opencontainers.image.description="Digest-pinned Node 24 and hash-locked Python/pytest benchmark runtime"
LABEL org.opencontainers.image.base.digest="sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03"
LABEL ai.zhivex.benchmark="time-to-safe-fix"

# A dated Debian snapshot prevents apt package resolution from drifting between
# benchmark runs. This slim base has no CA bundle, so bootstrap uses HTTP while
# APT still authenticates the signed repository metadata and packages. The image
# build requires network access unless the artifacts are available in a cache.
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources \
  && printf '%s\n' \
    'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260821T000000Z bookworm main' \
    'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260821T000000Z bookworm-updates main' \
    'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260821T000000Z bookworm-security main' \
    > /etc/apt/sources.list \
  && apt-get -o Acquire::Check-Valid-Until=false update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY docker/time-to-safe-fix.requirements.txt /tmp/time-to-safe-fix.requirements.txt
RUN python3 -m venv /opt/zhivex-python \
  && /opt/zhivex-python/bin/python -m pip install \
    --disable-pip-version-check \
    --no-cache-dir \
    --only-binary=:all: \
    --require-hashes \
    --requirement /tmp/time-to-safe-fix.requirements.txt \
  && rm /tmp/time-to-safe-fix.requirements.txt

ENV PATH="/opt/zhivex-python/bin:${PATH}" \
  PYTHONDONTWRITEBYTECODE="1" \
  PYTHONUNBUFFERED="1"

WORKDIR /workspace
