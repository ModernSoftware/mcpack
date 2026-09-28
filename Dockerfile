# Refresh this reviewed multi-platform digest when applying Node/OS security updates.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY runtimes ./runtimes
COPY examples ./examples
COPY docs ./docs
COPY README.md LICENSE NOTICE ./
# Package the same public files as npm; install runtime dependencies from the lockfile.
RUN npm pack --pack-destination /tmp \
    && mkdir /package \
    && tar -xzf /tmp/modern-software-mcpack-*.tgz -C /package --strip-components=1 \
    && npm ci --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /project
COPY --from=build /package /opt/mcpack
COPY --from=build /build/node_modules /opt/mcpack/node_modules
COPY examples/mixed/ /project/
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
# Liveness only: readiness is /readyz and must be checked separately by the platform.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/opt/mcpack/dist/cli.js"]
CMD ["serve", "/project/mcpack.json", "--transport", "http", "--host", "0.0.0.0", "--allow-host", "localhost", "--allow-host", "127.0.0.1", "--token-env", "MCPACK_HTTP_TOKEN"]

# Optional example workload; the default target below remains the minimal runtime.
FROM runtime AS support-desk
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv \
    && python3 -c "import urllib.request; urllib.request.urlretrieve('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem', '/opt/rds-ca.pem')"
COPY examples/support-desk/app/package.json examples/support-desk/app/package-lock.json /project/
RUN npm ci --omit=dev --ignore-scripts
COPY examples/support-desk/app/requirements.txt /tmp/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt
COPY examples/support-desk/app/ /project/
USER node
ENTRYPOINT ["node", "/project/serve.mjs"]
CMD []

FROM runtime AS default
