import { useEffect } from 'react'

export const APP_NAME = 'Git Artifact Pages'

/**
 * Tab titles read from the most specific page to its container, joined by " · ":
 * "<document> · <site>", "<site>", and "<page> · Git Artifact Pages" for pages outside
 * any site (the site picker is just "Git Artifact Pages").
 */
export function pageTitle(...parts: Array<string | undefined>) {
  const title = parts.filter((part): part is string => Boolean(part?.trim())).join(' · ')
  return title || APP_NAME
}

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = title
  }, [title])
}
