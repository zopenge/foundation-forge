import { selectTcpListeners } from '@openge/forge-process-control';

if (selectTcpListeners([], { ports: [3000] }).length !== 0) {
  throw new Error('process control consumer smoke failed');
}
