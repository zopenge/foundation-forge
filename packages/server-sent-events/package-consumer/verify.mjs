import { TextEncoder } from 'node:util';

import { createServerSentEventDecoder } from '@openge/forge-server-sent-events';

const decoder = createServerSentEventDecoder();
if (decoder.push(new TextEncoder().encode('data: ok\n\n'))[0]?.data !== 'ok') {
  throw new Error('SSE consumer smoke failed');
}
