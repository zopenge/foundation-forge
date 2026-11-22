import type { EvmNativePaymentVerifierOptions } from './contracts.js';
import { maxUint256 } from './evm-values.js';
import { readBlockHeader } from './rpc-response.js';

export async function checkConfirmations(
  call: EvmNativePaymentVerifierOptions['rpc'],
  paymentBlock: { readonly hash: string; readonly number: bigint },
  minimumConfirmations: bigint,
): Promise<'insufficient-confirmations' | 'noncanonical-block' | undefined> {
  if (minimumConfirmations === 1n) return;
  const targetNumber = paymentBlock.number + minimumConfirmations - 1n;
  if (targetNumber > maxUint256) return 'insufficient-confirmations';
  const readTarget = () => call({ method: 'eth_getBlockByNumber', params: [`0x${targetNumber.toString(16)}`, false] });
  const rawTarget = await readTarget();
  if (rawTarget === null) return 'insufficient-confirmations';
  const target = readBlockHeader(rawTarget);
  if (target.number !== targetNumber) return 'noncanonical-block';

  // 按父区块哈希回走，确认高度必须与付款所在分叉一致。
  let current = target;
  while (current.number > paymentBlock.number + 1n) {
    const rawParent = await call({ method: 'eth_getBlockByHash', params: [current.parentHash, false] });
    if (rawParent === null) return 'noncanonical-block';
    const parent = readBlockHeader(rawParent);
    if (parent.hash !== current.parentHash || parent.number !== current.number - 1n) return 'noncanonical-block';
    current = parent;
  }
  if (current.parentHash !== paymentBlock.hash) return 'noncanonical-block';

  // 遍历期间可能发生重组，按高度复核同一确认区块仍为规范区块。
  const rawCurrentTarget = await readTarget();
  if (rawCurrentTarget === null) return 'noncanonical-block';
  const currentTarget = readBlockHeader(rawCurrentTarget);
  if (currentTarget.number !== target.number || currentTarget.hash !== target.hash) return 'noncanonical-block';
}
