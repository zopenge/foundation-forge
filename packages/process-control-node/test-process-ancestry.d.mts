import type { ProcessDescriptor, ReadProcessIdentityRequest } from '@openge/forge-process-control';

/** 仅供仓库测试使用，不构成发布包的公开契约。 */
export interface WindowsTestProcessDescriptorReader {
  readDescriptor(request: ReadProcessIdentityRequest): Promise<ProcessDescriptor | undefined>;
}

export function createWindowsTestProcessDescriptorReader(options?: {
  readonly loadNative?: () => Promise<unknown>;
}): WindowsTestProcessDescriptorReader;
