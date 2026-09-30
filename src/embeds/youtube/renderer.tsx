function parseYouTubeValue(value: string): string {
  try {
    const url = new URL(value)
    const host = url.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] ?? value
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v') || value
      return url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/)?.[1] ?? value
    }
  } catch {
    return value
  }
  return value
}

const youtubeRenderer = {
  kind: 'youtube' as const,
  valueParser: 'youtube-video-id' as const,
  parseValue: parseYouTubeValue,
  matchesUrl: (url: URL) => url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'),
  fullWidthCss: 'html,body{width:100%!important;max-width:none!important;margin-left:0!important;margin-right:0!important} body>*,article{width:100%!important;max-width:none!important;box-sizing:border-box!important}',
  measureRootScript: "document.querySelector('article') || document.body?.firstElementChild"
}

export default youtubeRenderer
