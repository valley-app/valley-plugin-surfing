export type EmbedProviderKind = 'youtube' | 'x' | 'generic'
export type EmbedValueParser = 'youtube-video-id' | 'x-post-id' | 'identity'
export type EmbedThemeName = 'light' | 'dark'

export interface EmbedProviderPresentation {
  initialHeight: number
  autoSize: boolean
  fullWidth: boolean
  minHeight?: number
  maxHeight?: number
  aspectRatio?: string
  httpReferrer?: string
  fitWidth?: { naturalWidth: number; maxScale: number }
}

export interface EmbedProviderTheme {
  queryParameter: string
  values: Record<EmbedThemeName, string>
}

export interface EmbedProvider {
  schemaVersion: 1
  id: string
  displayName: string
  language: string
  template: string
  kind: EmbedProviderKind
  valueParser: EmbedValueParser
  presentation: EmbedProviderPresentation
  theme?: EmbedProviderTheme
  order: number
  directory: string
}

export interface EmbedRenderer {
  kind: EmbedProviderKind
  valueParser: EmbedValueParser
  parseValue: (value: string) => string
  matchesUrl: (url: URL) => boolean
  fullWidthCss: string
  measureRootScript: string
}
