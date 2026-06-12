/**
 * Static-analysis test: Tauri capability vs source code integrity
 *
 * Verifies that every @tauri-apps/plugin-fs function and @tauri-apps/plugin-dialog
 * function imported in source code has a corresponding permission entry in
 * src-tauri/capabilities/default.json.
 *
 * Background: v2.0.10 regression — useOcrEngine called mkdir() but
 * fs:allow-mkdir was not registered, causing silent failures at runtime.
 * Playwright e2e tests could not catch this because they mock all Tauri APIs.
 */

import { describe, it, expect } from 'vitest';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const CAPABILITIES_PATH = path.join(
  PROJECT_ROOT,
  'src-tauri',
  'capabilities',
  'default.json',
);
const SRC_DIR = path.join(PROJECT_ROOT, 'src');

/** Recursively collect all .ts and .tsx files under `dir`, excluding __tests__. */
function walkSrc(dir: string): string[] {
  const results: string[] = [];
  for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      results.push(...walkSrc(full));
    } else if (entry.isFile() && /\.(tsx?)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract all identifiers imported from @tauri-apps/plugin-fs in a file.
 * Handles both static imports and dynamic imports:
 *   import { writeFile, mkdir } from '@tauri-apps/plugin-fs'
 *   const { readFile } = await import('@tauri-apps/plugin-fs')
 */
function extractFsImports(filePath: string): string[] {
  const content = nodeFs.readFileSync(filePath, 'utf-8');
  const fns: string[] = [];

  // static imports
  const staticRe = /import\s*\{([^}]+)\}\s*from\s*['"]@tauri-apps\/plugin-fs['"]/g;
  let m: RegExpExecArray | null;
  while ((m = staticRe.exec(content)) !== null) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    fns.push(...names);
  }

  // dynamic imports: import('@tauri-apps/plugin-fs')
  const dynamicRe = /import\s*\(\s*['"]@tauri-apps\/plugin-fs['"]\s*\)/g;
  if (dynamicRe.test(content)) {
    // Extract destructured names from await import(...) patterns
    const dynDestructRe =
      /\{\s*([^}]+)\}\s*=\s*await\s+import\s*\(\s*['"]@tauri-apps\/plugin-fs['"]\s*\)/g;
    while ((m = dynDestructRe.exec(content)) !== null) {
      const names = m[1]
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      fns.push(...names);
    }
  }

  return fns;
}

/**
 * Extract all identifiers imported from @tauri-apps/plugin-dialog in a file.
 */
function extractDialogImports(filePath: string): string[] {
  const content = nodeFs.readFileSync(filePath, 'utf-8');
  const fns: string[] = [];

  const staticRe =
    /import\s*\{([^}]+)\}\s*from\s*['"]@tauri-apps\/plugin-dialog['"]/g;
  let m: RegExpExecArray | null;
  while ((m = staticRe.exec(content)) !== null) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    fns.push(...names);
  }

  return fns;
}

/** Map fs function name → required capability permission identifier */
const FS_PERMISSION_MAP: Record<string, string> = {
  writeFile: 'fs:allow-write-file',
  writeTextFile: 'fs:allow-write-text-file',
  mkdir: 'fs:allow-mkdir',
  remove: 'fs:allow-remove',
  readFile: 'fs:allow-read-file',
  readTextFile: 'fs:allow-read-text-file',
  stat: 'fs:allow-stat',
  exists: 'fs:allow-exists',
  rename: 'fs:allow-rename',
  readDir: 'fs:allow-read-dir',
};

/** Map dialog function name → required capability permission identifier */
const DIALOG_PERMISSION_MAP: Record<string, string> = {
  open: 'dialog:allow-open',
  save: 'dialog:allow-save',
  ask: 'dialog:allow-ask',
  message: 'dialog:allow-message',
  confirm: 'dialog:allow-confirm',
};

/**
 * Load permissions from capabilities/default.json.
 * Handles both plain strings and object identifiers:
 *   "fs:allow-write-file"
 *   { "identifier": "fs:allow-write-file", "allow": [...] }
 * Also resolves wildcard entries like "dialog:default".
 */
function loadCapabilityPermissions(): Set<string> {
  const raw = nodeFs.readFileSync(CAPABILITIES_PATH, 'utf-8');
  const cap = JSON.parse(raw) as {
    permissions: (string | { identifier: string })[];
  };

  const granted = new Set<string>();
  for (const entry of cap.permissions) {
    if (typeof entry === 'string') {
      granted.add(entry);
      // Expand known wildcard defaults
      if (entry === 'dialog:default') {
        // dialog:default includes open, save, ask, message, confirm
        granted.add('dialog:allow-open');
        granted.add('dialog:allow-save');
        granted.add('dialog:allow-ask');
        granted.add('dialog:allow-message');
        granted.add('dialog:allow-confirm');
      }
      if (entry === 'core:default') {
        granted.add('core:default');
      }
    } else {
      granted.add(entry.identifier);
    }
  }
  return granted;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tauri capability vs source integrity', () => {
  const sourceFiles = walkSrc(SRC_DIR);
  const granted = loadCapabilityPermissions();

  it('capabilities/default.json exists and is parseable', () => {
    expect(nodeFs.existsSync(CAPABILITIES_PATH)).toBe(true);
    const raw = nodeFs.readFileSync(CAPABILITIES_PATH, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('all @tauri-apps/plugin-fs functions used in source have corresponding allow-* in capabilities', () => {
    const usedFns = new Set<string>();
    for (const file of sourceFiles) {
      for (const fn of extractFsImports(file)) {
        if (fn in FS_PERMISSION_MAP) {
          usedFns.add(fn);
        }
      }
    }

    const missing: Array<{ fn: string; required: string }> = [];
    for (const fn of usedFns) {
      const required = FS_PERMISSION_MAP[fn];
      if (!granted.has(required)) {
        missing.push({ fn, required });
      }
    }

    expect(
      missing,
      `Missing capabilities for fs functions: ${JSON.stringify(missing, null, 2)}`,
    ).toEqual([]);
  });

  it('all @tauri-apps/plugin-dialog functions used in source have corresponding allow-* in capabilities', () => {
    const usedFns = new Set<string>();
    for (const file of sourceFiles) {
      for (const fn of extractDialogImports(file)) {
        if (fn in DIALOG_PERMISSION_MAP) {
          usedFns.add(fn);
        }
      }
    }

    const missing: Array<{ fn: string; required: string }> = [];
    for (const fn of usedFns) {
      const required = DIALOG_PERMISSION_MAP[fn];
      if (!granted.has(required)) {
        missing.push({ fn, required });
      }
    }

    expect(
      missing,
      `Missing capabilities for dialog functions: ${JSON.stringify(missing, null, 2)}`,
    ).toEqual([]);
  });

  it('writeTextFile usage has fs:allow-write-text-file in capabilities (v2.0.10 regression guard)', () => {
    const filesUsingWriteTextFile = sourceFiles.filter((f) =>
      extractFsImports(f).includes('writeTextFile'),
    );
    // At least one source file must use writeTextFile for this guard to be meaningful
    expect(filesUsingWriteTextFile.length).toBeGreaterThan(0);
    expect(
      granted.has('fs:allow-write-text-file'),
      'fs:allow-write-text-file is missing from capabilities/default.json but writeTextFile is used in source',
    ).toBe(true);
  });

  it('mkdir usage has fs:allow-mkdir in capabilities (v2.0.10 regression guard)', () => {
    const filesUsingMkdir = sourceFiles.filter((f) =>
      extractFsImports(f).includes('mkdir'),
    );
    // #285 switched run_ocr to a byte-based invoke and eliminated the JS-side
    // Tauri FS dependency, so directory creation now happens on the Rust side
    // and no JS source calls mkdir() anymore. The guard therefore only asserts
    // the capability when mkdir is actually imported from JS — if mkdir is ever
    // reintroduced without fs:allow-mkdir, this still fails like the v2.0.10
    // regression it was written for.
    if (filesUsingMkdir.length === 0) return;
    expect(
      granted.has('fs:allow-mkdir'),
      'fs:allow-mkdir is missing from capabilities/default.json but mkdir is used in source',
    ).toBe(true);
  });

  it('opener:default is present in capabilities (App.tsx open_log_folder guard)', () => {
    // App.tsx calls invoke('open_log_folder') which is backed by the opener plugin on the Rust
    // side. Without opener:default in capabilities the IPC call silently fails at runtime.
    expect(
      granted.has('opener:default'),
      'opener:default is missing from capabilities/default.json but open_log_folder (opener plugin) is used in App.tsx',
    ).toBe(true);
  });

  it('plugin-updater usage has updater:default in capabilities (PCT-093 regression guard)', () => {
    // PCT-093 (v2.0.16 regression): @tauri-apps/plugin-updater の check() を
    // 呼んでいるのに capabilities に updater 系 permission が無く、
    // チェックが即エラー → UI は silent のため「アップデート確認を押しても
    // 何も起きない」として隠蔽されていた。
    const usesUpdater = sourceFiles.some((f) =>
      nodeFs.readFileSync(f, 'utf-8').includes("@tauri-apps/plugin-updater"),
    );
    if (!usesUpdater) return;
    const hasUpdaterPermission = [...granted].some((p) => p.startsWith('updater:'));
    expect(
      hasUpdaterPermission,
      'updater permission (updater:default 等) is missing from capabilities/default.json but @tauri-apps/plugin-updater is used in source',
    ).toBe(true);
  });

  it('scope-aware: code using appLocalDataDir() has $APPLOCALDATA scope in at least one fs capability', () => {
    const usesAppLocalDataDir = sourceFiles.some((f) => {
      const content = nodeFs.readFileSync(f, 'utf-8');
      return content.includes('appLocalDataDir');
    });

    if (!usesAppLocalDataDir) {
      // Nothing to check
      return;
    }

    const raw = nodeFs.readFileSync(CAPABILITIES_PATH, 'utf-8');
    const cap = JSON.parse(raw) as {
      permissions: (string | { identifier: string; allow?: { path: string }[] })[];
    };

    const hasAppLocalDataScope = cap.permissions.some((entry) => {
      if (typeof entry === 'string') return false;
      return (
        entry.identifier.startsWith('fs:') &&
        Array.isArray(entry.allow) &&
        entry.allow.some((a) => a.path.includes('$APPLOCALDATA'))
      );
    });

    expect(
      hasAppLocalDataScope,
      'Source uses appLocalDataDir() but no fs:* capability has $APPLOCALDATA in its allow scope',
    ).toBe(true);
  });
});
