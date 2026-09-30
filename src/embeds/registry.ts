import youtubeProviderJson from './youtube/provider.json'
import xProviderJson from './x/provider.json'
import youtubeRenderer from './youtube/renderer'
import xRenderer from './x/renderer'
import type { EmbedProvider, EmbedProviderKind, EmbedRenderer, EmbedValueParser } from './types'

const identityRenderer: EmbedRenderer = {
  kind: 'generic',
  valueParser: 'identity',
  parseValue: (value) => value,
  matchesUrl: () => false,
  fullWidthCss: 'html,body{width:100%!important;max-width:none!important;margin-left:0!important;margin-right:0!important} body>*,article{width:100%!important;max-width:none!important;box-sizing:border-box!important}',
  measureRootScript: "document.querySelector('article') || document.body?.firstElementChild"
}

const renderers: Record<EmbedProviderKind, EmbedRenderer> = {
  youtube: youtubeRenderer,
  x: xRenderer,
  generic: identityRenderer
}

const runtimeRenderers = new Map<string, EmbedRenderer>()

export const BUILT_IN_PROVIDERS: EmbedProvider[] = [
  { ...(youtubeProviderJson as Omit<EmbedProvider, 'directory'>), directory: 'youtube' },
  { ...(xProviderJson as Omit<EmbedProvider, 'directory'>), directory: 'x' }
]

export function embedRenderer(kind: EmbedProviderKind): EmbedRenderer {
  return renderers[kind]
}

export function embedRendererForProvider(provider: Pick<EmbedProvider, 'directory' | 'kind' | 'valueParser'>): EmbedRenderer {
  const runtime = runtimeRenderers.get(provider.directory)
  if (runtime?.kind === provider.kind && runtime.valueParser === provider.valueParser) return runtime
  const fallback = embedRenderer(provider.kind)
  const parseValue = embedValueParser(provider.valueParser)
  return fallback.valueParser === provider.valueParser ? fallback : {
    ...fallback,
    valueParser: provider.valueParser,
    parseValue
  }
}

export function installRuntimeEmbedRenderers(next: ReadonlyMap<string, EmbedRenderer>): void {
  runtimeRenderers.clear()
  for (const [directory, renderer] of next) runtimeRenderers.set(directory, renderer)
}

export function embedRendererModuleSource(renderer: EmbedRenderer): string {
  return [
    `const parseValue = ${renderer.parseValue.toString()}`,
    `const matchesUrl = ${renderer.matchesUrl.toString()}`,
    `const renderer = { kind: ${JSON.stringify(renderer.kind)}, valueParser: ${JSON.stringify(renderer.valueParser)}, parseValue, matchesUrl, fullWidthCss: ${JSON.stringify(renderer.fullWidthCss)}, measureRootScript: ${JSON.stringify(renderer.measureRootScript)} }`,
    'export default renderer',
    ''
  ].join('\n')
}

export function embedValueParser(parser: EmbedValueParser): EmbedRenderer['parseValue'] {
  return Object.values(renderers).find((renderer) => renderer.valueParser === parser)?.parseValue ?? identityRenderer.parseValue
}

export function embedRendererForUrl(value: string): EmbedRenderer {
  try {
    const url = new URL(value)
    return Object.values(renderers).find((renderer) => renderer.matchesUrl(url)) ?? identityRenderer
  } catch {
    return identityRenderer
  }
}
