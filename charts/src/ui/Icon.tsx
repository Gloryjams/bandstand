// Inline SVG icon set  -  no emoji (pro-app policy). Stroke-based, inherits color.
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

function base(size = 20): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }
}

export const IconLibrary = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M4 5v14M9 5v14" /><rect x="13" y="4" width="7" height="16" rx="1" transform="rotate(8 16 12)" /></svg>
)
export const IconList = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg>
)
export const IconPlus = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 5v14M5 12h14" /></svg>
)
export const IconSearch = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
)
export const IconPlay = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M7 5l12 7-12 7V5z" fill="currentColor" stroke="none" /></svg>
)
export const IconEdit = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>
)
export const IconTrash = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
)
export const IconCopy = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
)
export const IconClose = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M6 6l12 12M18 6 6 18" /></svg>
)
export const IconChevronLeft = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M15 18l-6-6 6-6" /></svg>
)
export const IconChevronRight = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M9 18l6-6-6-6" /></svg>
)
export const IconMinus = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M5 12h14" /></svg>
)
export const IconCheck = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M20 6 9 17l-5-5" /></svg>
)
export const IconImport = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
)
export const IconSparkle = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" /><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z" /></svg>
)
export const IconMoon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M20 13.5A8 8 0 1 1 10.5 4 6.5 6.5 0 0 0 20 13.5Z" /></svg>
)
export const IconScroll = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 4v16m0 0-5-5m5 5 5-5M12 4 7 9m5-5 5 5" /></svg>
)
export const IconNote = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" fill="currentColor" stroke="none" /><circle cx="17" cy="16" r="3" fill="currentColor" stroke="none" /></svg>
)
export const IconExport = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 15V3m0 0 4 4m-4-4-4 4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
)
export const IconSettings = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.2A1.6 1.6 0 0 0 7 19.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4.6 15H4a2 2 0 1 1 0-4h.2A1.6 1.6 0 0 0 5.7 8.3l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 11 4.6V4a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-1.1 2.7H21a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1z" /></svg>
)
