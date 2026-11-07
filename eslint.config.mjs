import tseslint from 'typescript-eslint';
import awscdk from 'eslint-plugin-awscdk';
export default [
  { ignores: ['**/node_modules/**', '**/cdk.out/**', '**/.local/**', '**/Wire.ts'] },
  ...tseslint.configs.recommended,
  { files: ['infra/**/*.ts'], plugins: { awscdk }, rules: {} }
];
