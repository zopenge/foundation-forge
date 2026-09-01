import { PeerNetworkError } from '../network/errors.js';

const headerBytes = 4;

export interface CreateLengthPrefixedFrameCodecOptions {
  readonly maxMessageBytes: number;
}

export interface LengthPrefixedFrameCodec {
  decode(chunk: Uint8Array): readonly Uint8Array[];
  encode(message: Uint8Array): Uint8Array;
}

const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
};

export const createLengthPrefixedFrameCodec = ({
  maxMessageBytes,
}: CreateLengthPrefixedFrameCodecOptions): LengthPrefixedFrameCodec => {
  let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();

  const assertMessageSize = (messageBytes: number): void => {
    if (messageBytes > maxMessageBytes) {
      throw new PeerNetworkError('message-too-large', {
        maxMessageBytes,
        messageBytes,
      });
    }
  };

  return {
    decode: (chunk) => {
      buffered = concatBytes(buffered, chunk);
      const messages: Uint8Array[] = [];

      while (buffered.byteLength >= headerBytes) {
        const messageBytes = new DataView(
          buffered.buffer,
          buffered.byteOffset,
          headerBytes,
        ).getUint32(0);
        assertMessageSize(messageBytes);

        const frameBytes = headerBytes + messageBytes;
        if (buffered.byteLength < frameBytes) {
          break;
        }

        messages.push(buffered.slice(headerBytes, frameBytes));
        buffered = buffered.slice(frameBytes);
      }

      return messages;
    },
    encode: (message) => {
      assertMessageSize(message.byteLength);
      const frame = new Uint8Array(headerBytes + message.byteLength);
      new DataView(frame.buffer).setUint32(0, message.byteLength);
      frame.set(message, headerBytes);
      return frame;
    },
  };
};
