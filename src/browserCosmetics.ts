import type { ValleyPluginApi } from '@valley/plugin-sdk'

const FEATURES = `(() => {
  const classes = new Set(), ids = new Set(), hrefs = new Set();
  for (const element of document.querySelectorAll('[class],[id],a[href]')) {
    for (const name of element.classList) if (name.length <= 128 && classes.size < 1000) classes.add(name);
    if (element.id && element.id.length <= 128 && ids.size < 1000) ids.add(element.id);
    const href = element.getAttribute('href'); if (href && href.length <= 2048 && hrefs.size < 1000) hrefs.add(href);
  }
  return {url:location.href,classes:[...classes],ids:[...ids],hrefs:[...hrefs]};
})()`

export function watchBrowserCosmetics(api: ValleyPluginApi, guestId: string, partition: string, owner: {
  active(): boolean
  revision(): number
} = { active: () => true, revision: () => 0 }): () => Promise<void> {
  let active = true
  let pending = false
  let initial = true
  let previous = ''
  let generation = 0
  const styles = new Set<string>()
  const work = new Set<Promise<unknown>>()
  let disposal: Promise<void> | undefined
  const track = (operation: Promise<unknown>): void => {
    work.add(operation)
    void operation.then(() => work.delete(operation), () => work.delete(operation))
  }
  const update = async (): Promise<void> => {
    if (!active || !owner.active() || pending) return
    pending = true
    const revision = owner.revision(), acceptedGeneration = generation
    const current = (): boolean => active && owner.active() && revision === owner.revision() && generation === acceptedGeneration
    try {
      const features = await api.drivers.browser.execute(guestId, FEATURES)
      if (!current() || !features.ok || !features.data) return
      const signature = JSON.stringify(features.data)
      if (signature === previous) return
      const result = await api.backend.call<{ styles: string; scripts: string[] }>('filter.cosmetics', { partition, ...(features.data as object), initial })
      if (!current()) return
      previous = signature
      initial = false
      if (result.styles && !styles.has(result.styles)) {
        styles.add(result.styles)
        const css = [...styles].join('\n')
        if (css.length <= 1024 * 1024) await api.drivers.browser.styles(guestId, 'page-filter', css)
      }
      for (const script of result.scripts) if (current()) await api.drivers.browser.execute(guestId, script, true)
    } catch (error) { console.error(error) }
    finally { pending = false }
  }
  const off = api.backend.on('filter.changed', () => {
    if (!active || !owner.active()) return
    generation++
    previous = ''; initial = true; styles.clear()
    track(api.drivers.browser.styles(guestId, 'page-filter', '').then(() => update()).catch(error => console.error(error)))
  })
  track(update())
  const timer = setInterval(() => track(update()), 2000)
  return () => {
    if (disposal) return disposal
    active = false; off(); clearInterval(timer)
    return disposal = (async () => { while (work.size) await Promise.allSettled([...work]) })()
  }
}
