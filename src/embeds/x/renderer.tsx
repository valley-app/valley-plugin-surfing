function parseXValue(value: string): string {
  try {
    const url = new URL(value)
    const host = url.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) {
      return url.pathname.match(/\/status\/(\d+)/)?.[1] ?? value
    }
  } catch {
    return value
  }
  return value
}

const xRenderer = {
  kind: 'x' as const,
  valueParser: 'x-post-id' as const,
  parseValue: parseXValue,
  matchesUrl: (url: URL) => url.hostname === 'platform.twitter.com',
  fullWidthCss: 'html,body,body>div,body>div>div,iframe{width:100%!important;max-width:none!important;margin-left:0!important;margin-right:0!important;padding-left:0!important;padding-right:0!important;box-sizing:border-box!important} article{width:100%!important;max-width:none!important;margin-left:0!important;margin-right:0!important;box-sizing:border-box!important}',
  measureRootScript: "document.querySelector('article') || document.body?.firstElementChild"
}

export default xRenderer
