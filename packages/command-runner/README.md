# @openge/forge-command-runner

Asynchronous, provider-neutral command contracts with an explicit Node adapter. Command Runner owns one child process, output delivery, capture limits, and execution deadlines. Process Control owns process inspection and identity-checked tree termination; the caller supplies its chosen Provider.

## Explicit Node setup

```ts
import process from 'node:process';
import type { ProcessControlProvider } from '@openge/forge-process-control';
import { createNodeCommandRunner } from '@openge/forge-command-runner/node';

export async function execute(processControl: ProcessControlProvider) {
  const runner = createNodeCommandRunner({
    platform: 'win32', // Use 'posix' when the caller selects that platform.
    processControl,
    terminationPolicy: { mode: 'force' },
    identityAcquisition: { timeoutMs: 2_000, pollIntervalMs: 20 },
    terminationTimeoutMs: 5_000,
  });
  return runner.run({
    command: process.execPath,
    args: ['--version'],
    environment: { mode: 'inherit' },
    output: { mode: 'capture', maxBytesPerStream: 16_384, overflow: 'truncate' },
    timeoutMs: 10_000,
  });
}
```

The root entry exports only types, structured errors, and pure specification normalization. Node I/O is available only from `./node`. For explicit POSIX configuration, the child starts in its own process group so identity-checked Process Control tree termination can address the group. Windows configuration retains the normal child-process grouping. There is no automatic platform or Provider selection, and no dependency on a Process Control Node implementation. Applications performing command-line tasks and applications managing external tools can share these contracts while retaining their own orchestration and presentation.

## Specifications and output

`command` is an executable; `args` is a separate array. Values are passed directly with `shell: false`, including spaces, quotes, and Unicode. The runner never parses a command string or enables a shell. Relative executable and working-directory resolution follows Node's spawn contract. `normalizeCommandSpec` validates synchronously and snapshots and freezes arguments, environment values, and output settings.

An omitted `environment` means `{ mode: 'inherit' }`. Inherit mode overlays `values` on the parent environment; an undefined value removes a variable. Replace mode uses only the supplied values. With explicit `platform: 'win32'`, overrides match variable names without case sensitivity; POSIX overrides are case-sensitive.

- `events` (default): synchronously delivers stdout and stderr byte chunks without retaining output.
- `capture`: also retains at most `maxBytesPerStream` bytes independently for stdout and stderr. `truncate` keeps the first N bytes and sets truncation flags; `fail` requests termination and reports `output-overflow` with a structured diagnostic.
- `ignore`: discards both streams and delivers no output events.

Capture limits are positive integers. Byte truncation can split a UTF-8 sequence. Decoding, combining streams, formatting logs, asynchronous queues, and persistent logging belong to the consumer. Capture retention is bounded per stream; observers receive independent byte arrays so modifying an event cannot corrupt captured output.

## Lifecycle and termination

`start()` returns `pid`, `identity`, and `result` promises plus an idempotent `terminate('abort' | 'timeout')`. `run()` returns the same result semantics. Invalid specifications throw synchronously. A signal aborted before start prevents spawning; `pid` rejects with `COMMAND_ABORTED_BEFORE_START`, `identity` resolves to null, and the result reports `abort`. A spawn failure similarly rejects `pid` and returns a structured `start-failure`. An ignored pid rejection does not create an unhandled rejection.

The runner emits `spawned`, then performs bounded identity observation using the injected Provider. A successful identity is frozen and emitted as `identified`. If a command exits before observation completes, identity may be null. If a live child cannot be identified by the acquisition deadline, the result reports `COMMAND_IDENTITY_UNAVAILABLE` and `start-failure`; the runner attempts cleanup through its direct ChildProcess handle. It never passes a bare PID to tree termination.

Execution timeout and duration begin when Node reports successful spawning. Optional heartbeats run only while the child is alive. Timeout, AbortSignal, manual termination, and capture overflow share one termination operation, including synchronous observer reentrancy. Normal termination always passes the captured identity to `terminateProcessTree`.

The required `terminationTimeoutMs` is a total management budget starting at the first termination request, including any remaining identity wait, the Provider call, and waiting for child exit. It is independent of `identityAcquisition.timeoutMs` and must cover `gracePeriodMs` for a graceful-then-force policy. Both deadlines remain effective when a Provider promise never settles. The runner passes an AbortSignal to Provider operations and aborts it when the operation is no longer needed. If termination fails or exceeds its budget, the runner attempts direct-child cleanup and returns `termination-failure` without waiting for an uncooperative Provider. That failure cannot certify descendant cleanup; the operating system may still be completing direct-child teardown when the failed result is delivered.

After process exit, the same explicit `terminationTimeoutMs` also bounds waiting for inherited output pipes to close. If descendants keep those pipes open past that resource-closure budget, the runner destroys its own streams and reports `termination-failure` with diagnostic stage `stream-close-deadline`. It does not attempt tree termination against the exited parent identity.

Natural exit preserves the exit code; signal exit preserves the signal. Product-specific status mappings remain in the consumer. Completion removes timers, stream listeners, and the caller's AbortSignal listener, and releases stream handles. The observer receives one final `exited` event.

## Observers and boundaries

Observers are synchronous, non-blocking callbacks. Exceptions become `COMMAND_OBSERVER_FAILED` diagnostics and do not stop the lifecycle, including exceptions from the final event. Repeated errors are coalesced by diagnostic code to keep diagnostic retention bounded. Async observer work, rejection handling, queue limits, and backpressure are the consumer's responsibility; the runner never waits on observer promises or builds an internal promise queue.

The adapter provides no synchronous command API, shell execution, global SIGINT/SIGTERM handlers, service supervision, readiness probes, restarts, service dependency graphs, log prefixes, tee behavior, port rules, or browser launching.

## Validation

`pnpm --filter @openge/forge-command-runner test` covers real child processes, byte capture, environments, identity and termination deadlines, observer failures, and cleanup. Repository package verification packs real tarballs, validates the browser root boundary, and runs this package's consumer fixtures against clean installed tarballs.
