# Deployment candidate: trusted Node/Python tools

This reference targets trusted handler code and one service identity. It is a release
candidate workflow, not a production certification. Per-user/tenant identity, per-tool
authorization and full MCP OAuth resource-server behavior are outside this scope.

## Build and run the reference image

From the repository root:

```sh
docker build --pull -t mcpack:candidate .
# Supply MCPACK_HTTP_TOKEN through your shell/secret manager; do not commit it.
docker run --name mcpack --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 256m --cpus 1 --pids-limit 64 \
  -p 127.0.0.1:3000:3000 -e MCPACK_HTTP_TOKEN mcpack:candidate
```

The image runs the mixed example as the non-root `node` user. Missing/empty service
tokens stop startup. The example has sequential execution and recovery disabled;
set worker `maxConcurrent`/`recovery` in your project's manifest explicitly. Resources
above are smoke-test settings, not workload sizing recommendations.

The image contains Node 24 and Debian Bookworm's Python 3.11. The Node base is pinned
to a reviewed multi-platform digest; npm uses package-lock.json and npm ci. Python/OS
packages are resolved from Debian repositories at build time, so independent builds
are not guaranteed byte-identical. Build once, scan and deploy the resulting image by
its digest. Refresh base digests and OS packages when applying security updates.

The multi-stage build packs MCPack using its npm file list and copies that package
plus lockfile-installed production dependencies into the final image. TypeScript and
other development dependencies stay in the build stage. The default example needs
no third-party handler dependencies. For your own image, copy project code and
lockfile-installed dependencies into /project, or mount a prepared project read-only.
Install Python dependencies in a venv and set the worker executable to that venv;
do not install dependencies at container startup. Include only required runtimes.

Code in /project and the installed package can stay read-only. Give application state
an explicitly mounted writable directory and configure handlers to use it. /tmp is
bounded ephemeral scratch; durable data belongs in a database/object store. Do not
put secrets in Docker build arguments, image layers, literal manifest env fields or
committed files. The build context uses an allowlist and excludes environment files.

```sh
# Example custom project, already built with its dependencies:
docker run --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:3000:3000 -e MCPACK_HTTP_TOKEN \
  --mount type=bind,source=/absolute/project,target=/project,readonly \
  mcpack:candidate
```

On Windows Git Bash, use Docker-compatible absolute paths and disable MSYS path
conversion when necessary. The npm library remains cross-platform; this reference
container is Linux. CI exercises the Linux amd64 image, not every architecture.

## HTTP boundary and cloud deployment

- Terminate TLS at the trusted ingress. Keep direct backend access restricted.
- Preserve Host and configure explicit allowed hosts. Keep 127.0.0.1 allowed if using
  the image's internal health probe. Configure an allowed HTTPS Origin explicitly
  when browser clients send one; forwarded headers do not establish trust.
- The service-token gate authorizes access to the whole MCP endpoint. It does not
  express user identity or per-tool permissions. A custom authorize callback must
  fail closed and honor its AbortSignal when performing external validation.
- Gateway OAuth alone is not a claim of complete MCP OAuth interoperability. Design
  resource metadata, audience validation and the backend trust boundary before
  accepting end-user OAuth tokens. Never blindly forward client tokens to tools.
- Inject secrets at runtime and give DB/S3/API access least-privilege permissions.
  In AWS, workload identity credentials may come from SDK providers (for example a
  task role). The necessary SDK environment variables must be explicitly inherited
  by each worker; MCPack does not forward the entire host environment automatically.
- Treat diagnostic output as sensitive. Applications must avoid logging credentials;
  quota limits bound delivery, not disclosure. Infrastructure errors/health do not
  expose raw factory/handler exceptions to MCP clients.

Configure ingress request/body/rate limits alongside MCPack limits. `maxInFlight` and
worker concurrency are process-local, so replicas multiply downstream connections
and load. A container memory limit covers the Node host and all children together;
there is no per-worker hard memory quota. Bound DB queries, caches and response sizes.
An OOM kill may affect the host or any child and requires deployment-level recovery.

## Probes and shutdown

The image HEALTHCHECK uses /healthz for liveness. Configure the platform to use /readyz
for routing readiness; it returns 503 while any worker recovers or remains failed.
Do not turn temporary readiness failure into an immediate container restart loop.
Probe bodies disclose status only. Configure the proxy's probe Host to match the
allowlist; test your actual load balancer's behavior during the AWS experiment.

The exec-form entrypoint delivers SIGTERM directly to the CLI. Allow a stop grace
period greater than the HTTP drain period plus worker shutdown timeout and scheduling
margin (for defaults, start with 15 seconds and validate). Active writes may already
have committed; neither forced termination nor recovery rolls them back. Handler-
spawned descendants are not individually supervised. Kubernetes deployments should
use normal container/process isolation and an appropriate init/reaping policy if
application tools spawn subprocesses.

## Required evidence before 0.9.0

The container CI builds the candidate and checks non-root/read-only operation,
authentication, mixed-language capabilities, Python worker death/recovery, missing
credentials, and SIGTERM shutdown using the installed package. It does not publish an
image. Run locally with `node test/container-smoke.mjs mcpack:candidate` after npm ci.

The AWS experiment remains issue #14. Validate real DB/S3/API permissions and failure
modes, ingress/TLS/probes, ambiguous writes and application idempotency, restart budget
exhaustion, rollout/shutdown, aggregate process memory, sustained load and downstream
throttling. Record the image/package versions, workload and observed limits. Publish
0.9.0 only after resolving demonstrated blockers, then pin the sample to that release.
