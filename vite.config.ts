import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

type EnvLike = { GITHUB_REPOSITORY?: string };

const env = (globalThis as { process?: { env?: EnvLike } }).process?.env;
const repositoryName = env?.GITHUB_REPOSITORY?.split('/')[1] ?? 'wrokit';

export default defineConfig({
  plugins: [react()],
  base: `/${repositoryName}/`
});
