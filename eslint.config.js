import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'src-tauri'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 未使用変数は _ プレフィックスで許容
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // any は警告のみ（Tauri/pdf-lib の型が不完全なため）
      '@typescript-eslint/no-explicit-any': 'warn',
      // console.warn/error は許容
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
)
