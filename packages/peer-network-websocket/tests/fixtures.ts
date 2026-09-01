import type { PeerAdvertisement } from '@openge/forge-peer-network';

export class FakeWebSocket {
  onclose: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onopen: ((event: Event) => unknown) | null = null;
  readyState = 0;
  readonly sent: string[] = [];

  close(): void {
    this.readyState = 3;
    this.onclose?.(new Event('close'));
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  receive(value: unknown): void {
    this.onmessage?.(new MessageEvent('message', {
      data: JSON.stringify(value),
    }));
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

export class FakeRendezvousConnection {
  readonly closeCalls: Array<{ readonly code?: number; readonly reason?: string }> = [];
  readonly sent: string[] = [];

  close(code?: number, reason?: string): void {
    this.closeCalls.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

export const localAdvertisement: PeerAdvertisement = {
  endpoint: {
    addresses: ['/ip4/127.0.0.1/tcp/4001'],
    peerId: 'local-peer',
  },
  scopeId: 'scope-a',
};

export const remoteAdvertisement: PeerAdvertisement = {
  endpoint: {
    addresses: ['/ip4/127.0.0.1/tcp/4002'],
    peerId: 'remote-peer',
  },
  scopeId: 'scope-a',
};
