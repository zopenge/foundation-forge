# @openge/forge-peer-network

Provider-neutral peer networking contracts and reusable protocol utilities with
zero runtime third-party dependencies.

```sh
pnpm add @openge/forge-peer-network
```

The root entry exports peer endpoints, advertisements, networks, providers,
connections, message channels, discovery contracts, structured errors, a
length-prefixed frame codec, cancellable operation control, and a bounded peer
dial scheduler.

This package does not select or implement a transport. Install an explicit
Provider package separately.

Licensed under the Apache License 2.0.
