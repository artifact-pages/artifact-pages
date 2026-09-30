import type { Preview } from '@storybook/react-vite'
import '../src/styles.css'

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    controls: { expanded: true },
  },
}

export default preview
