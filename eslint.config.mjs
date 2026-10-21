import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // deploy/mongo-init.js mongosh muhitida ishlaydi (db, process global), Node kodi emas
  { ignores: ['dist', 'coverage', 'node_modules', 'deploy'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
