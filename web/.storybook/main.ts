import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  framework: '@storybook/react-vite',
  staticDirs: ['../../fixtures/storage', { from: '../../docs/public/sites', to: '/docs-sites' }],
}

export default config
