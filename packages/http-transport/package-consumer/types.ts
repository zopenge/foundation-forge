import { classifyHttpTransportError, type HttpTransport, type NodeHttpTransportOptions } from '@openge/forge-http-transport';
import { createNodeHttpTransport } from '@openge/forge-http-transport/node';

const options: NodeHttpTransportOptions = { route: 'proxy', environment: {}, tls: { ca: ['PEM'] } };
const client: HttpTransport = createNodeHttpTransport(options);
const fetch: typeof globalThis.fetch = client.fetch;
const request = new Request('https://example.invalid', { method: 'POST', body: 'bytes' });
const response: Promise<Response> = fetch(request, { headers: { accept: 'application/json' } });
void response;
void client.describeRoute(new URL('https://example.invalid'));
void classifyHttpTransportError(new Error());
void client.close();
