# Wallet authentication contracts

The product supplies a server-issued challenge with an origin, same-origin URI, operation, wallet account and validity window. The browser signs a message from that challenge and returns its proof. Adapters return a verified wallet identity or a structured error.

Persist each issued challenge in the product's session store. For sign-in or linking, verify against the persisted challenge and atomically consume it when issuing the session or binding the wallet. The same verified proof can be passed to a stateless verifier more than once, so consuming the challenge is a product responsibility.

Select an explicit protocol adapter and an explicit browser connector. The core contains no session, user, storage or payment policy.
