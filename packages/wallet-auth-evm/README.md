# EVM wallet authentication

Generate a SIWE message with `createEvmWalletMessage(challenge)` on the server, and send the challenge and message to the browser. Verify with `verifyEvmWalletProof({ challenge, proof, now })` using the original stored challenge. The returned account uses a lowercase EVM address in the `eip155` namespace and the decimal chain ID.

For EOA verification, omit `verifyContractSignature`. Both 65-byte signatures and compact EIP-2098 signatures are supported. For an account that requires contract verification, select `createErc1271Verifier(readContract)` as `verifyContractSignature` using trusted server-side account information. The verifier then uses only the selected contract verifier. Route each request to the trusted read-only RPC configured for its exact chain ID. Return the result of `eth_call` to the given address with the provided calldata. A recognized contract rejection should return a non-magic result. Infrastructure errors produce `verification-unavailable` so that a product can retry without consuming the challenge.

Use `localhost` or `127.0.0.1` for local HTTP SIWE challenges. The EVM adapter returns `invalid-challenge` for IPv6 literal authorities.

After verification, atomically consume the original challenge and commit the application's account or session update.
