import { createOxlintConfig } from '@d3lm/lint-preset/oxlint';
import { defineConfig } from 'oxlint';

export default defineConfig({
  extends: [createOxlintConfig()],
  rules: {
    '@d3lm/comment-syntax': ['error', { ignoredWords: ['Node', 'Node.js'] }],
  },
});
