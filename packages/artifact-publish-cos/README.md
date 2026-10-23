# @openge/forge-artifact-publish-cos

An explicit Node.js Tencent COS Provider for `@openge/forge-artifact-publish`. It uses the official SDK's public signing API and owns its HTTP(S) requests and sockets for bounded cancellation and closure.

```ts
import { publishArtifactFiles } from '@openge/forge-artifact-publish/node';
import { createCosArtifactTransport } from '@openge/forge-artifact-publish-cos';

const transport = createCosArtifactTransport({
  bucket, // Full bucket name, including numeric APPID suffix.
  region,
  credentials: { secretId, secretKey, sessionToken },
});
const receipt = await publishArtifactFiles(transport, absoluteRoot, filePlan, {
  concurrency: 4, timeoutMilliseconds: 600_000, closeTimeoutMilliseconds: 5_000,
  maxObjectBytes: 32 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024,
  maxPointerBytes: 64 * 1024,
  concurrencyControl: { mode: 'external-serialization', scope: 'artifact-channel' },
  pathCaseSensitivity: 'case-sensitive', signal,
});
```

Credentials are explicit and private, never included in receipts or raw error causes. The Provider does not discover credentials, refresh sessions, create buckets, configure CDN, or select resources. Supply credentials valid for the operation duration.

## Storage requirements

The bucket must have **never enabled versioning**. The Provider first reads and strictly validates bucket versioning. Enabled, Suspended, unreadable, or ambiguous configuration fails before writes. COS's `x-cos-forbid-overwrite` is ineffective with enabled versioning; see the [official PUT Object documentation](https://www.tencentcloud.com/document/product/436/7749).

Immutable writes carry `x-cos-forbid-overwrite: true`. Only `409 FileAlreadyExists` permits byte verification and reuse. This does not protect against other credentials that overwrite or delete objects. Keep bucket configuration stable and restrict write/delete permissions for immutable prefixes. Every pointer writer and rollback must use the same external serial coordinator; ordinary COS PUT is not destination If-Match CAS.

Objects and pointers are verified by GET of actual bytes and exact Content-Type/Cache-Control, never by treating ETag as SHA-256. Uploads include Content-MD5 and Content-Length. This version uses single PUT, capped at 5,000,000,000 bytes, and buffered reads; set practical lower Core limits for available memory. No automatic retries or multipart uploads.

The default endpoint is `https://<bucket>.cos.<region>.myqcloud.com`. An explicit `endpoint` must be an origin without userinfo, path, query, or fragment. HTTPS is required except literal loopback `127.0.0.1` / `[::1]` HTTP for controlled tests. Never use an untrusted origin: requests contain authorization and optional session token. Redirects are rejected.

Targets record provider, region/bucket, and actual endpoint origin. Errors are structured; Core receipts distinguish accepted, already-existing, and unknown writes. Cancellation cannot undo an accepted upload or pointer write. Create a fresh transport per operation; Core closes it on every outcome.

The entry is Node-only (Node.js 22.14+). Controlled HTTP protocol tests and real tarball consumers exercise success, conflict, malformed responses, cancellation, and socket closure. They do not claim live COS/CDN acceptance or create resources. See the [maintenance guide](../../docs/packages/artifacts/artifact-publish-cos.md).
