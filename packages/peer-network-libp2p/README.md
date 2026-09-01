# @openge/forge-peer-network-libp2p

Explicit libp2p providers for the Foundation Forge peer networking contracts.

```sh
pnpm add @openge/forge-peer-network @openge/forge-peer-network-libp2p
```

For pnpm 10 workspaces, explicitly allow the required WebRTC native build and
mark the React Native platform peer as conditional:

```yaml
allowBuilds:
  node-datachannel: true

packageExtensions:
  "react-native-webrtc@*":
    peerDependenciesMeta:
      react-native:
        optional: true
```

Choose one public entry explicitly:

- `@openge/forge-peer-network-libp2p/node`
- `@openge/forge-peer-network-libp2p/browser`
- `@openge/forge-peer-network-libp2p/relay`

Public signatures use Foundation Forge contracts and do not expose libp2p,
stream, private-key, or multiaddr implementation types.

Licensed under the Apache License 2.0.
