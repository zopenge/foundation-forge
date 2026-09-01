export const peerNetworkErrorCodes = [
  'channel-closed',
  'channel-open-timeout',
  'connect-timeout',
  'invalid-endpoint',
  'message-too-large',
  'network-closed',
  'peer-unreachable',
  'protocol-rejected',
  'send-timeout',
] as const;

export type PeerNetworkErrorCode = (typeof peerNetworkErrorCodes)[number];

export type PeerNetworkErrorDetails = Readonly<Record<string, unknown>>;

export class PeerNetworkError extends Error {
  readonly code: PeerNetworkErrorCode;
  readonly details: PeerNetworkErrorDetails | undefined;

  constructor(
    code: PeerNetworkErrorCode,
    details?: PeerNetworkErrorDetails,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'PeerNetworkError';
    this.code = code;
    this.details = details;
  }
}
