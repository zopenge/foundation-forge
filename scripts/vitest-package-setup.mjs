import { expect, inject, vi } from 'vitest';
import { selectPackageTestSettings } from './vitest-package-settings.mjs';

const selected = selectPackageTestSettings(expect.getState().testPath, inject('forgePackageSettings'));
const settings = Object.fromEntries(Object.entries(selected).filter(([key]) => key !== 'packageRoot'));
// 保留受控fork继承的cwd；只恢复每文件原有超时，未声明值仍由Vitest解析。
vi.setConfig(settings);
