import { createUiText } from './localization'
import type { ValleyPluginApi, BrowserSnapshotResult, BrowserTextResult, BrowserHtmlResult, BrowserActionResult } from '@valley/plugin-sdk'

export function browserAutomation(api: ValleyPluginApi) {
  const uiText = createUiText(api)
  const runJs = async (guestId: string, script: string, userGesture = false): Promise<unknown> => {
    const result = await api.drivers.browser.execute(guestId, script, userGesture)
    if (!result.ok) throw new Error(result.error || uiText('surfing.error.action'))
    return result.data
  }
interface SnapshotElement {
  ref: number
  role: string
  name: string
  value?: string
  disabled?: boolean
  inViewport?: boolean
}
interface SnapshotResult {
  url: string
  title: string
  count: number
  text: string
  elements: SnapshotElement[]
}
/** Set-of-marks: number every visible interactive element, keep the live nodes on
 *  `window.__valleyMarks`, and return a compact, JSON-cloneable description. */
const SNAPSHOT_JS = `(() => {
  const sel = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="menuitem"], [contenteditable=""], [contenteditable="true"], [onclick]';
  const seen = new Set();
  const marks = [];
  const elements = [];
  for (const el of document.querySelectorAll(sel)) {
    if (seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || el.offsetParent === null) continue;
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (type || 'text') : tag);
    let name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ');
    if (name.length > 100) name = name.slice(0, 100) + '…';
    const ref = marks.length;
    marks.push(el);
    elements.push({
      ref, role, name,
      value: (tag === 'input' || tag === 'textarea') && el.value ? String(el.value).slice(0, 100) : undefined,
      disabled: (el.disabled === true || el.getAttribute('aria-disabled') === 'true') || undefined,
      inViewport: r.top >= 0 && r.top < innerHeight && r.left >= 0 && r.left < innerWidth
    });
    if (marks.length >= 200) break;
  }
  window.__valleyMarks = marks;
  return { url: location.href, title: document.title, count: elements.length, elements };
})()`

function formatSnapshot(elements: SnapshotElement[]): string {
  if (!elements.length) return '(no interactive elements found)'
  return elements
    .map((e) => {
      const bits = [`[${e.ref}]`, e.role]
      if (e.name) bits.push(JSON.stringify(e.name))
      if (e.value) bits.push(`= ${JSON.stringify(e.value)}`)
      if (e.disabled) bits.push('(disabled)')
      if (e.inViewport === false) bits.push('(off-screen)')
      return bits.join(' ')
    })
    .join('\n')
}

async function snapshot(guestId: string): Promise<SnapshotResult> {
  const raw = (await runJs(guestId, SNAPSHOT_JS)) as Omit<SnapshotResult, 'text'>
  return { ...raw, text: formatSnapshot(raw.elements) }
}

async function readText(guestId: string, maxChars = 8000): Promise<{ text: string }> {
  const text = (await runJs(guestId, 'document.body ? document.body.innerText : ""')) as string
  return { text: text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text }
}

async function readHtml(guestId: string): Promise<{ url: string; title: string; html: string }> {
  return await runJs(guestId, '({url:location.href,title:document.title,html:document.documentElement?.outerHTML||""})') as { url: string; title: string; html: string }
}

async function act(guestId: string, ref: number, body: string): Promise<string> {
  const js = `(() => {
    const el = (window.__valleyMarks || [])[${ref}];
    if (!el) return { ok: false, error: ${JSON.stringify(uiText('surfing.error.staleElement', { value: ref }))} };
    try { ${body} } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  })()`
  const res = (await runJs(guestId, js, true)) as { ok: boolean; info?: string; error?: string }
  if (!res || !res.ok) throw new Error(res?.error || uiText('surfing.error.action'))
  return res.info || 'ok'
}

function click(guestId: string, ref: number): Promise<string> {
  return act(
    guestId,
    ref,
    `el.scrollIntoView({ block: 'center', inline: 'center' }); el.click(); return { ok: true, info: 'Clicked element ${ref}.' };`
  )
}

function typeText(guestId: string, ref: number, text: string, submit?: boolean): Promise<string> {
  const t = JSON.stringify(text)
  const submitJs = submit
    ? `if (el.form && el.form.requestSubmit) el.form.requestSubmit(); else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));`
    : ''
  const body = `
    el.focus();
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${t});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = ${t};
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else {
      return { ok: false, error: ${JSON.stringify(uiText('surfing.error.notText', { value: ref }))} };
    }
    ${submitJs}
    return { ok: true, info: 'Typed into element ${ref}.' };`
  return act(guestId, ref, body)
}

function selectOption(guestId: string, ref: number, value: string): Promise<string> {
  const v = JSON.stringify(value)
  return act(
    guestId,
    ref,
    `el.value = ${v}; el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, info: 'Selected ' + ${v} + ' in element ${ref}.' };`
  )
}

async function scroll(guestId: string, dx: number, dy: number): Promise<string> {
  await runJs(guestId, `window.scrollBy(${Math.round(dx)}, ${Math.round(dy)})`)
  return `Scrolled by (${Math.round(dx)}, ${Math.round(dy)}).`
}

  const result = async <T>(operation: () => Promise<T>) => {
    try { return { ok: true as const, data: await operation() } }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) } }
  }
  return {
    snapshot: (guestId: string): Promise<BrowserSnapshotResult> => result(() => snapshot(guestId)),
    readText: (guestId: string, maxChars?: number): Promise<BrowserTextResult> => result(() => readText(guestId, maxChars)),
    readHtml: (guestId: string): Promise<BrowserHtmlResult> => result(() => readHtml(guestId)),
    click: (guestId: string, ref: number): Promise<BrowserActionResult> => result(async () => ({info: await click(guestId, ref)})),
    type: (guestId: string, ref: number, text: string, submit?: boolean): Promise<BrowserActionResult> => result(async () => ({info: await typeText(guestId, ref, text, submit)})),
    select: (guestId: string, ref: number, value: string): Promise<BrowserActionResult> => result(async () => ({info: await selectOption(guestId, ref, value)})),
    scroll: (guestId: string, dx: number, dy: number): Promise<BrowserActionResult> => result(async () => ({info: await scroll(guestId, dx, dy)}))
  }
}
