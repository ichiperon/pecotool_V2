import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const appPath = resolve(process.cwd(), 'src/App.tsx');
const sourceText = readFileSync(appPath, 'utf8');
const sourceFile = ts.createSourceFile(appPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findUseBatchJobConfig(): ts.ObjectLiteralExpression {
  let found: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'useBatchJob'
      && node.arguments.length > 0
      && ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      found = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error('useBatchJob config object was not found in App.tsx');
  return found;
}

function propertyText(objectLiteral: ts.ObjectLiteralExpression, name: string): string {
  const property = objectLiteral.properties.find((prop) =>
    ts.isPropertyAssignment(prop)
    && ts.isIdentifier(prop.name)
    && prop.name.text === name
  );
  if (!property || !ts.isPropertyAssignment(property)) {
    throw new Error(`${name} property was not found`);
  }
  return property.initializer.getText(sourceFile);
}

describe('App batch/folder OCR save wiring (PCT-036)', () => {
  it('batch overwrite save callback bypasses the OCR-running guard', () => {
    const config = findUseBatchJobConfig();

    expect(propertyText(config, 'savePdf')).toBe('() => handleSave({ bypassOcrGuard: true })');
  });

  it('batch open callback keeps the existing OCR-running guard bypass', () => {
    const config = findUseBatchJobConfig();

    expect(propertyText(config, 'openPdf')).toBe('(path) => handleOpen(path, { bypassOcrGuard: true })');
  });

  it('folder OCR save callback also bypasses the OCR-running guard', () => {
    expect(sourceText).toContain('folderSavePdfRef.current = () => handleSave({ bypassOcrGuard: true });');
  });

  it('manual shortcut save remains wired to the guarded handleSave path', () => {
    expect(sourceText).toContain('undo, redo, fitToScreen, handleSave, handleSaveAs, copySelected');
  });
});
