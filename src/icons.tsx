import { React } from './runtime'
import type { ReactElement, ReactNode } from 'react'
import { uiText } from './localization'

/**
 * Inline SVG glyphs drawn with the host's React. Plugins cannot bundle
 * react-icons (it would pull in a second React), so the glyphs are hand-rolled
 * and stay monochrome via `currentColor`. Each is a component so the JSX only
 * runs at render time — never at module top level.
 */
type IconProps = { className?: string }

const Svg = (props: IconProps & { children: ReactNode }): ReactElement =>
  React.createElement(
    'svg',
    {
      className: props.className,
      width: '1em',
      height: '1em',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true
    },
    props.children
  )

export const ValleyIcon = (p: IconProps): ReactElement => (
  <svg className={p.className} width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true"
    style={{ mask: 'var(--icon-open-in-new) center / contain no-repeat' }}>
    <rect width="24" height="24" fill="currentColor" />
  </svg>
)

/** A private/incognito glyph — the switcher's permanent "new private tab" row.
 *  Bootstrap's `incognito` artwork, inlined: it is filled (not stroked) and lives
 *  in a 16×16 box, so it draws its own `<svg>` instead of the shared one. */
export const IncognitoIcon = ({ className }: IconProps): ReactElement => (
  <svg className={className} width="1em" height="1em" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path
      fillRule="evenodd"
      d="m4.736 1.968-.892 3.269-.014.058C2.113 5.568 1 6.006 1 6.5 1 7.328 4.134 8 8 8s7-.672 7-1.5c0-.494-1.113-.932-2.83-1.205l-.014-.058-.892-3.27c-.146-.533-.698-.849-1.239-.734C9.411 1.363 8.62 1.5 8 1.5s-1.411-.136-2.025-.267c-.541-.115-1.093.2-1.239.735m.015 3.867a.25.25 0 0 1 .274-.224c.9.092 1.91.143 2.975.143a30 30 0 0 0 2.975-.143.25.25 0 0 1 .05.498c-.918.093-1.944.145-3.025.145s-2.107-.052-3.025-.145a.25.25 0 0 1-.224-.274M3.5 10h2a.5.5 0 0 1 .5.5v1a1.5 1.5 0 0 1-3 0v-1a.5.5 0 0 1 .5-.5m-1.5.5q.001-.264.085-.5H2a.5.5 0 0 1 0-1h3.5a1.5 1.5 0 0 1 1.488 1.312 3.5 3.5 0 0 1 2.024 0A1.5 1.5 0 0 1 10.5 9H14a.5.5 0 0 1 0 1h-.085q.084.236.085.5v1a2.5 2.5 0 0 1-5 0v-.14l-.21-.07a2.5 2.5 0 0 0-1.58 0l-.21.07v.14a2.5 2.5 0 0 1-5 0zm8.5-.5h2a.5.5 0 0 1 .5.5v1a1.5 1.5 0 0 1-3 0v-1a.5.5 0 0 1 .5-.5"
    />
  </svg>
)

export const TrashIcon = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M4 7h16" />
    <path d="M10 11v6M14 11v6" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
    <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
  </Svg>
)

/** Reading-list glyph matching the eyeglasses shape used by Bootstrap Icons. */
export const EyeglassesIcon = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <circle cx="7" cy="13" r="4" />
    <circle cx="17" cy="13" r="4" />
    <path d="M11 13h2M3.2 11.3 5 5h2M20.8 11.3 19 5h-2" />
  </Svg>
)

export const ChevronIcon = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <polyline points="6 9 12 15 18 9" />
  </Svg>
)

/** Row affordance on a settings list page — "this opens its own page". */
export const ChevronRightIcon = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <polyline points="9 6 15 12 9 18" />
  </Svg>
)

/** The back chevron in a list page's sub-page band. */
export const ChevronLeftIcon = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <polyline points="15 6 9 12 15 18" />
  </Svg>
)

const GLYPHS: Record<string, (p: IconProps) => ReactElement> = {
  person: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5 20c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5" />
    </Svg>
  ),
  home: (p) => (
    <Svg {...p}>
      <path d="M4 11l8-7 8 7" />
      <path d="M6.5 9.8V20h11V9.8" />
    </Svg>
  ),
  work: (p) => (
    <Svg {...p}>
      <rect x="3" y="7.5" width="18" height="12" rx="2" />
      <path d="M9 7.5v-2a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <path d="M3 12.5h18" />
    </Svg>
  ),
  school: (p) => (
    <Svg {...p}>
      <path d="M12 4 2 9l10 5 10-5-10-5Z" />
      <path d="M6 11.5V17c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.5" />
    </Svg>
  ),
  globe: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
    </Svg>
  ),
  star: (p) => (
    <Svg {...p}>
      <path d="m12 3.5 2.7 5.5 6 .9-4.35 4.2 1.05 6L12 17.3l-5.4 2.8 1.05-6L3.3 9.9l6-.9L12 3.5Z" />
    </Svg>
  ),
  shield: (p) => (
    <Svg {...p}>
      <path d="M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3Z" />
    </Svg>
  ),
  flask: (p) => (
    <Svg {...p}>
      <path d="M10 3v6.2L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 9.2V3" />
      <path d="M9 3h6" />
      <path d="M7.2 14h9.6" />
    </Svg>
  ),
  cart: (p) => (
    <Svg {...p}>
      <circle cx="9.5" cy="19.5" r="1.5" />
      <circle cx="17" cy="19.5" r="1.5" />
      <path d="M2.5 4h2.6l2.4 11h11l2-7.5H6" />
    </Svg>
  ),
  heart: (p) => (
    <Svg {...p}>
      <path d="M12 20.5s-7.5-4.6-7.5-9.7a4.3 4.3 0 0 1 7.5-2.8 4.3 4.3 0 0 1 7.5 2.8c0 5.1-7.5 9.7-7.5 9.7Z" />
    </Svg>
  )
}

/**
 * The pickable profile marks, built per call so the labels follow the app
 * language. A profile with no icon falls back to the first letter of its name.
 */
export function profileGlyphs(): { id: string; label: string }[] {
  return [
    { id: 'person', label: uiText('auto.8c41ae88467f') },
    { id: 'home', label: uiText('auto.70f8bb9a8a53') },
    { id: 'work', label: uiText('auto.00040bab8a78') },
    { id: 'school', label: uiText('auto.f2f3d66a7978') },
    { id: 'globe', label: uiText('auto.03e00429aeff') },
    { id: 'star', label: uiText('auto.85a7de6e2705') },
    { id: 'shield', label: uiText('auto.08271419319f') },
    { id: 'flask', label: uiText('auto.be601df25eea') },
    { id: 'cart', label: uiText('auto.96a0dc481b16') },
    { id: 'heart', label: uiText('auto.2a37335eebda') }
  ]
}

/** A profile's chosen glyph; unknown/empty ids render nothing (letter fallback). */
export const ProfileGlyph = ({ id, className }: { id?: string; className?: string }): ReactElement | null => {
  const Glyph = id ? GLYPHS[id] : undefined
  return Glyph ? <Glyph className={className} /> : null
}

/** The square mark that stands for a profile: its glyph, else its first letter. */
export const ProfileMark = ({
  icon,
  name,
  className = 'web-profile-mark'
}: {
  icon?: string
  name?: string
  className?: string
}): ReactElement => (
  <span className={className}>
    {icon && GLYPHS[icon] ? <ProfileGlyph id={icon} /> : (name?.trim()[0] ?? '?').toUpperCase()}
  </span>
)
