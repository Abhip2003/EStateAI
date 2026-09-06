import nextConfig from 'eslint-config-next';

// eslint-config-next (v16) ships a native ESLint flat-config array — no
// FlatCompat/legacy shim needed, and using one here trips a
// converting-circular-json crash in @eslint/eslintrc's validator against
// this plugin graph under ESLint 10.
const eslintConfig = [...nextConfig, { ignores: ['.next/**', 'node_modules/**'] }];

export default eslintConfig;
