import {
  processControlErrorCodes,
  type SelectTcpListenersOptions,
  type TcpListener,
} from './contracts.js';
import { ProcessControlError } from './errors.js';

export function selectTcpListeners(
  listeners: readonly TcpListener[],
  options: SelectTcpListenersOptions,
): readonly TcpListener[] {
  const ports = new Set(options.ports.map(validatePort));
  const selected = new Map<string, TcpListener>();
  for (const listener of listeners) {
    validateListener(listener);
    if (ports.has(listener.port)) {
      selected.set(listenerKey(listener), listener);
    }
  }
  return [...selected.values()].toSorted(compareListeners);
}

function validateListener(listener: TcpListener): void {
  validatePort(listener.port);
  if (
    listener.address.length === 0
    || !Number.isSafeInteger(listener.process.pid)
    || listener.process.pid <= 0
    || listener.process.startToken.length === 0
  ) {
    throw new ProcessControlError(processControlErrorCodes.invalidInput);
  }
}

function validatePort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ProcessControlError(processControlErrorCodes.invalidInput, { port });
  }
  return port;
}

function listenerKey(listener: TcpListener): string {
  return [
    listener.address,
    String(listener.port),
    String(listener.process.pid),
    listener.process.startToken,
  ].join('\0');
}

function compareListeners(left: TcpListener, right: TcpListener): number {
  return left.port - right.port
    || compareStrings(left.address, right.address)
    || left.process.pid - right.process.pid
    || compareStrings(left.process.startToken, right.process.startToken);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
