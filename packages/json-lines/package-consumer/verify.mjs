import { parseJsonLines } from '@openge/forge-json-lines';

if (parseJsonLines('{"a":1}\n').length !== 1) throw new Error('JSON Lines consumer smoke failed');
