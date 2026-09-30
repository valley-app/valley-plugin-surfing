import DOMPurify from 'dompurify'
import * as css from 'css-tree'
import { binaryString, decodeText, resolveArchiveUrl, type ArchivePart, type MhtmlArchive } from './archives'

const imageType = /^image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/
const fontType = /^(?:font\/[a-z0-9-]+|application\/(?:font-woff|x-font-woff|x-font-ttf|vnd\.ms-fontobject))$/
const safeData = /^data:(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon)|font\/[a-z0-9-]+);base64,[a-z\d+/=\s]+$/i

export function archiveDocument(archive: MhtmlArchive): string {
  const locations = new Map(archive.parts.map(part => [part.location, part]))
  const ids = new Map(archive.parts.filter(part => part.id).map(part => [part.id, part]))
  const resources = new Map<ArchivePart, string>()
  const find = (value: string, base: string): ArchivePart | undefined => {
    if (/^cid:/i.test(value)) {
      try { return ids.get(decodeURIComponent(value.slice(4)).replace(/^<|>$/g, '')) } catch { return undefined }
    }
    const url = resolveArchiveUrl(value, base)
    return locations.get(url) ?? locations.get(url.split('#')[0])
  }
  const resource = (value: string, base: string): string => {
    if (safeData.test(value)) return value
    const part = find(value, base)
    if (!part) return ''
    const previous = resources.get(part)
    if (previous) return previous
    let type = part.type
    if (type === 'application/octet-stream') {
      const extension = /\.(woff2?|ttf|otf)(?:[?#]|$)/i.exec(part.location)?.[1].toLowerCase()
      if (extension) type = `font/${extension}`
    }
    if (!imageType.test(type) && !fontType.test(type)) return ''
    let bytes = part.bytes
    if (type === 'image/svg+xml') {
      const svg = DOMPurify.sanitize(decodeText(bytes, part.charset), { USE_PROFILES: { svg: true }, FORBID_TAGS: ['style', 'foreignObject'], FORBID_ATTR: ['style', 'href', 'xlink:href'] })
      bytes = new TextEncoder().encode(svg)
    }
    const result = `data:${type};base64,${btoa(binaryString(bytes))}`
    resources.set(part, result)
    return result
  }
  const styles = (source: string, base: string, stack = new Set<ArchivePart>(), inline = false): string => {
    try {
      const tree = css.parse(source, { context: inline ? 'declarationList' : 'stylesheet' })
      css.walk(tree, function(node, item, list) {
        if (node.type === 'Raw') { if (list && item) list.remove(item); return this.skip }
        if (node.type === 'Atrule' && node.name.toLowerCase() === 'import') {
          const prelude = node.prelude?.type === 'AtrulePrelude' ? node.prelude.children.toArray() : []
          const target = prelude[0]
          const part = target && (target.type === 'String' || target.type === 'Url') ? find(target.value, base) : undefined
          let replacement = ''
          if (part?.type === 'text/css' && !stack.has(part) && stack.size < 20) {
            const next = new Set(stack).add(part)
            replacement = styles(decodeText(part.bytes, part.charset), part.location, next)
            const media = prelude.slice(1).map(value => css.generate(value)).join(' ')
            if (media) replacement = `@media ${media}{${replacement}}`
          }
          if (item && list) list.replace(item, (css.parse(replacement) as css.StyleSheet).children)
          return this.skip
        }
        if (node.type === 'Url') node.value = resource(node.value, base)
        if (node.type === 'Function' && /^(?:-webkit-)?image-set$/i.test(node.name)) {
          node.children.forEach(child => { if (child.type === 'String') child.value = resource(child.value, base) })
        }
      })
      return css.generate(tree).replace(/<\/style/gi, '<\\/style')
    } catch { return '' }
  }
  const clean = DOMPurify.sanitize(decodeText(archive.root.bytes, archive.root.charset), {
    WHOLE_DOCUMENT: true, USE_PROFILES: { html: true }, ADD_TAGS: ['link'],
    FORBID_TAGS: ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'base', 'audio', 'video', 'source'],
    FORBID_ATTR: ['srcset', 'ping', 'download', 'autofocus', 'contenteditable', 'srcdoc'], ALLOW_DATA_ATTR: false
  })
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  for (const style of doc.querySelectorAll('style')) style.textContent = styles(style.textContent ?? '', archive.root.location)
  for (const link of doc.querySelectorAll('link')) {
    const part = link.rel.toLowerCase() === 'stylesheet' ? find(link.getAttribute('href') ?? '', archive.root.location) : undefined
    if (part?.type === 'text/css') {
      const style = doc.createElement('style')
      style.textContent = styles(decodeText(part.bytes, part.charset), part.location, new Set([part]))
      if (link.media) style.media = link.media
      link.replaceWith(style)
    } else link.remove()
  }
  for (const element of doc.querySelectorAll('*')) {
    for (const attr of [...element.attributes]) {
      if (attr.name === 'style') element.setAttribute('style', styles(attr.value, archive.root.location, new Set(), true))
      else if (attr.name === 'src' || attr.name === 'background' || attr.name === 'poster') {
        const value = resource(attr.value, archive.root.location)
        if (value) element.setAttribute(attr.name, value)
        else element.removeAttribute(attr.name)
      } else if (attr.name === 'href') {
        const target = resolveArchiveUrl(attr.value, archive.root.location)
        const hash = target.indexOf('#')
        if (element.tagName === 'A' && hash >= 0 && target.slice(0, hash) === archive.root.location.split('#')[0]) element.setAttribute('href', target.slice(hash))
        else element.removeAttribute(attr.name)
      }
    }
    element.removeAttribute('target')
  }
  const policy = doc.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  doc.head.prepend(policy)
  return `<!doctype html>${doc.documentElement.outerHTML}`
}
