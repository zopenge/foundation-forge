import type { PeerAdvertisement } from '@openge/forge-peer-network';

export type WebSocketRendezvousClientMessage =
  | { readonly type: 'ping' }
  | {
      readonly advertisement: PeerAdvertisement;
      readonly token: string;
      readonly type: 'register';
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseAdvertisement = (value: unknown): PeerAdvertisement | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const scopeId = typeof value.scopeId === 'string' ? value.scopeId.trim() : '';
  if (scopeId.length === 0 || scopeId.length > 128 || !isRecord(value.endpoint)) {
    return undefined;
  }
  const peerId = typeof value.endpoint.peerId === 'string'
    ? value.endpoint.peerId.trim()
    : '';
  if (
    peerId.length === 0
    || peerId.length > 128
    || !Array.isArray(value.endpoint.addresses)
  ) {
    return undefined;
  }
  const addresses = value.endpoint.addresses.filter(
    (address): address is string => (
      typeof address === 'string'
      && address.length > 0
      && address.length <= 1_024
    ),
  );
  if (
    addresses.length === 0
    || addresses.length !== value.endpoint.addresses.length
    || addresses.length > 16
  ) {
    return undefined;
  }
  return {
    endpoint: {
      addresses,
      peerId,
    },
    scopeId,
  };
};

export const parseWebSocketRendezvousClientMessage = (
  raw: string,
): WebSocketRendezvousClientMessage | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.type === 'ping') {
    return { type: 'ping' };
  }
  if (value.type !== 'register') {
    return undefined;
  }
  const advertisement = parseAdvertisement(value.advertisement);
  const token = typeof value.token === 'string' ? value.token : '';
  if (advertisement === undefined || token.length === 0) {
    return undefined;
  }
  return {
    advertisement,
    token,
    type: 'register',
  };
};

export const parseWebSocketRendezvousAdvertisements = (
  value: unknown,
): readonly PeerAdvertisement[] | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.type !== 'advertisements' || !Array.isArray(value.advertisements)) {
    return undefined;
  }
  return value.advertisements.flatMap((advertisement) => {
    const parsed = parseAdvertisement(advertisement);
    return parsed === undefined ? [] : [parsed];
  });
};
