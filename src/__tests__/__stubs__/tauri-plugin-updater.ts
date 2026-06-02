// Test stub for @tauri-apps/plugin-updater
// This file is used by vitest alias to satisfy imports during testing.
// The real module is installed at Tauri runtime and is not available in node_modules
// until `npm install` is run after the package.json entry is added in Feature #202.
import { vi } from 'vitest';

export const check = vi.fn().mockResolvedValue(null);
