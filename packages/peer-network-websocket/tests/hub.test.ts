import { afterEach, describe, expect, test, vi } from 'vitest';

import { createWebSocketRendezvousHub } from '../src/server.js';
import {
  FakeRendezvousConnection,
  localAdvertisement,
  remoteAdvertisement,
} from './fixtures.js';

const registration = (
  advertisement = localAdvertisement,
  token = 'token',
): string => JSON.stringify({ advertisement, token, type: 'register' });

describe('WebSocket rendezvous hub', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('authorizes registrations and broadcasts scoped advertisements', async () => {
    const opaqueToken = 't'.repeat(257);
    const hub = createWebSocketRendezvousHub<{ readonly expectedScopeId: string }>({
      authorizeRegistration: ({ advertisement, context, token }) => (
        advertisement.scopeId === context.expectedScopeId && token === opaqueToken
      ),
      sweepIntervalMs: false,
    });
    const firstConnection = new FakeRendezvousConnection();
    const secondConnection = new FakeRendezvousConnection();
    const firstSession = hub.openSession(firstConnection, { expectedScopeId: 'scope-a' });
    const secondSession = hub.openSession(secondConnection, { expectedScopeId: 'scope-a' });

    await firstSession.receive(registration(localAdvertisement, opaqueToken));
    await secondSession.receive(registration(remoteAdvertisement, opaqueToken));

    const expected = {
      advertisements: [localAdvertisement, remoteAdvertisement],
      type: 'advertisements',
    };
    expect(JSON.parse(firstConnection.sent.at(-1) ?? '')).toEqual(expected);
    expect(JSON.parse(secondConnection.sent.at(-1) ?? '')).toEqual(expected);

    secondSession.close();
    expect(JSON.parse(firstConnection.sent.at(-1) ?? '')).toEqual({
      advertisements: [localAdvertisement],
      type: 'advertisements',
    });
    hub.close();
  });

  test('replaces a duplicate peer without losing the replacement index', async () => {
    const hub = createWebSocketRendezvousHub({
      authorizeRegistration: () => true,
      sweepIntervalMs: false,
    });
    const originalConnection = new FakeRendezvousConnection();
    const replacementConnection = new FakeRendezvousConnection();
    const remoteConnection = new FakeRendezvousConnection();
    const originalSession = hub.openSession(originalConnection, undefined);
    const replacementSession = hub.openSession(replacementConnection, undefined);
    const remoteSession = hub.openSession(remoteConnection, undefined);
    const replacementAdvertisement = {
      ...localAdvertisement,
      endpoint: {
        ...localAdvertisement.endpoint,
        addresses: ['/ip4/127.0.0.1/tcp/5001'],
      },
    };

    await originalSession.receive(registration());
    await replacementSession.receive(registration(replacementAdvertisement));
    await remoteSession.receive(registration(remoteAdvertisement));

    expect(originalConnection.closeCalls).toEqual([{ code: 1008, reason: 'peer-replaced' }]);
    expect(JSON.parse(replacementConnection.sent.at(-1) ?? '')).toEqual({
      advertisements: [replacementAdvertisement, remoteAdvertisement],
      type: 'advertisements',
    });
    hub.close();
  });

  test('rejects unauthorized, malformed, oversized, and unregistered heartbeat messages', async () => {
    const diagnostics: string[] = [];
    const hub = createWebSocketRendezvousHub({
      authorizeRegistration: ({ token }) => token === 'secret-token',
      maxPayloadBytes: 256,
      onDiagnostic: (event) => diagnostics.push(event.code),
      sweepIntervalMs: false,
    });
    const cases = [
      [registration(localAdvertisement, 'wrong-token'), 1008, 'invalid-token'],
      ['{', 1008, 'invalid-message'],
      ['x'.repeat(257), 1009, 'message-too-large'],
      [JSON.stringify({ type: 'ping' }), 1008, 'invalid-message'],
    ] as const;

    for (const [message, code, reason] of cases) {
      const connection = new FakeRendezvousConnection();
      await hub.openSession(connection, undefined).receive(message);
      expect(connection.closeCalls).toEqual([{ code, reason }]);
    }
    expect(diagnostics).toEqual([
      'unauthorized-registration',
      'invalid-message',
      'message-too-large',
      'unregistered-heartbeat',
    ]);
    hub.close();
  });

  test('enforces the message rate, scope count, and peer count limits', async () => {
    const diagnostics: string[] = [];
    const rateHub = createWebSocketRendezvousHub({
      authorizeRegistration: () => true,
      maxMessagesPerWindow: 1,
      onDiagnostic: (event) => diagnostics.push(event.code),
      sweepIntervalMs: false,
    });
    const rateConnection = new FakeRendezvousConnection();
    const rateSession = rateHub.openSession(rateConnection, undefined);
    await rateSession.receive(registration());
    await rateSession.receive(JSON.stringify({ type: 'ping' }));
    expect(rateConnection.closeCalls).toEqual([{ code: 1011, reason: 'rate-limit' }]);
    rateHub.close();

    const limitHub = createWebSocketRendezvousHub({
      authorizeRegistration: () => true,
      maxPeersPerScope: 1,
      maxScopes: 1,
      onDiagnostic: (event) => diagnostics.push(event.code),
      sweepIntervalMs: false,
    });
    await limitHub.openSession(new FakeRendezvousConnection(), undefined).receive(registration());
    const fullConnection = new FakeRendezvousConnection();
    await limitHub.openSession(fullConnection, undefined).receive(registration(remoteAdvertisement));
    const secondScopeConnection = new FakeRendezvousConnection();
    await limitHub.openSession(secondScopeConnection, undefined).receive(registration({
      ...remoteAdvertisement,
      scopeId: 'scope-b',
    }));

    expect(fullConnection.closeCalls).toEqual([{ code: 1013, reason: 'scope-full' }]);
    expect(secondScopeConnection.closeCalls).toEqual([{ code: 1013, reason: 'scope-limit' }]);
    expect(diagnostics).toEqual(['rate-limit', 'scope-full', 'scope-limit']);
    limitHub.close();
  });

  test('expires idle sessions and closes all sessions on shutdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const expiringHub = createWebSocketRendezvousHub({
      authorizeRegistration: () => true,
      sweepIntervalMs: 10,
      ttlMs: 20,
    });
    const expiringConnection = new FakeRendezvousConnection();
    expiringHub.openSession(expiringConnection, undefined);
    await vi.advanceTimersByTimeAsync(30);
    expect(expiringConnection.closeCalls).toEqual([{
      code: 1001,
      reason: 'registration-expired',
    }]);
    expiringHub.close();

    const shutdownHub = createWebSocketRendezvousHub({
      authorizeRegistration: () => true,
      sweepIntervalMs: false,
    });
    const connection = new FakeRendezvousConnection();
    shutdownHub.openSession(connection, undefined);
    shutdownHub.close();
    shutdownHub.close();
    expect(connection.closeCalls).toEqual([{ code: 1001, reason: 'server-shutdown' }]);

    const lateConnection = new FakeRendezvousConnection();
    shutdownHub.openSession(lateConnection, undefined);
    expect(lateConnection.closeCalls).toEqual([{ code: 1001, reason: 'server-shutdown' }]);
  });
});
