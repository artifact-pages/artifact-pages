import { useEffect } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { deepSreIndex } from '../stories/fixtures'
import { SiteHome as SiteHomeView } from './SiteHome'

type SiteHomeStoryArgs = {
  theme: 'light' | 'dark'
}

function SiteHomeStory({ theme }: SiteHomeStoryArgs) {
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <SiteHomeView index={{ ...deepSreIndex, artifacts: [] }} />
  )
}

const meta = {
  title: 'Product/Site home (empty)',
  args: {
    theme: 'light',
  },
  argTypes: {
    theme: { control: 'radio', options: ['light', 'dark'] },
  },
  parameters: {
    layout: 'fullscreen',
  },
  render: (args: SiteHomeStoryArgs) => <SiteHomeStory {...args} />,
} satisfies Meta<SiteHomeStoryArgs>

export default meta
type Story = StoryObj<typeof meta>

export const SiteHome: Story = {
  name: 'Empty site',
}
