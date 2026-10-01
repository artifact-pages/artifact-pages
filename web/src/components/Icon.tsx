type IconName =
  | 'home'
  | 'library'
  | 'sidebar'
  | 'search'
  | 'chevron'
  | 'file'
  | 'folder'
  | 'contents'
  | 'info'
  | 'copy'
  | 'external'
  | 'close'
  | 'moon'
  | 'sun'
  | 'monitor'
  | 'arrow'
  | 'clock'
  | 'tree'
  | 'more'
  | 'pin'
  | 'history'

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.35,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  }

  switch (name) {
    case 'home':
      return <svg {...common}><path d="m2 7 6-4.8L14 7" /><path d="M3.8 6.3v6.9h8.4V6.3M6.3 13.2V9h3.4v4.2" /></svg>
    case 'library':
      return <svg {...common}><rect x="2" y="2" width="4.7" height="5.2" rx="1" /><rect x="9.3" y="2" width="4.7" height="5.2" rx="1" /><rect x="2" y="9" width="4.7" height="5" rx="1" /><rect x="9.3" y="9" width="4.7" height="5" rx="1" /></svg>
    case 'sidebar':
      return <svg {...common}><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2.3" /><path d="M6 2.8v10.4" /></svg>
    case 'search':
      return <svg {...common}><circle cx="6.7" cy="6.7" r="4.6" /><path d="m10.1 10.1 3.2 3.2" /></svg>
    case 'chevron':
      return <svg {...common}><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
    case 'file':
      return <svg {...common}><path d="M4 1.8h5l3.2 3.3v9.1H4z" /><path d="M9 1.8v3.5h3.2" /></svg>
    case 'folder':
      return <svg {...common}><path d="M1.8 4.2h4l1.5 1.6h6.9v6.7H1.8z" /><path d="M1.8 5.8V3.5h4.4l1.4 1.4" /></svg>
    case 'contents':
      return <svg {...common}><path d="M3 3.2h10M3 6.8h10M3 10.4h7" /><circle cx="2" cy="3.2" r=".35" fill="currentColor" stroke="none" /><circle cx="2" cy="6.8" r=".35" fill="currentColor" stroke="none" /><circle cx="2" cy="10.4" r=".35" fill="currentColor" stroke="none" /></svg>
    case 'info':
      return <svg {...common}><circle cx="8" cy="8" r="5.9" /><path d="M8 7.2v4" /><circle cx="8" cy="4.7" r=".45" fill="currentColor" stroke="none" /></svg>
    case 'copy':
      return <svg {...common}><rect x="5.3" y="4.5" width="7.2" height="9" rx="1.5" /><path d="M9.2 2.1H4.1a1.5 1.5 0 0 0-1.5 1.5v6.9" /></svg>
    case 'external':
      return <svg {...common}><path d="M8.5 2.5h5v5M13.2 2.8 7 9" /><path d="M12.2 8.7v4.8H2.8V4.1h4.8" /></svg>
    case 'close':
      return <svg {...common}><path d="m3.5 3.5 9 9m0-9-9 9" /></svg>
    case 'moon':
      return <svg {...common}><path d="M12.9 9.4A5.8 5.8 0 0 1 6.6 3.1 5.8 5.8 0 1 0 12.9 9.4Z" /></svg>
    case 'sun':
      return <svg {...common}><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.3M8 13.2v1.3M14.5 8h-1.3M2.8 8H1.5m11.1-4.6-.9.9m-7.4 7.4-.9.9m9.2 0-.9-.9M4.3 4.3l-.9-.9" /></svg>
    case 'monitor':
      return <svg {...common}><rect x="1.8" y="2.4" width="12.4" height="8.8" rx="1.7" /><path d="M5.5 13.6h5M8 11.2v2.4" /></svg>
    case 'arrow':
      return <svg {...common}><path d="M3 8h9m-3.5-3.5L12 8l-3.5 3.5" /></svg>
    case 'clock':
      return <svg {...common}><circle cx="8" cy="8" r="5.7" /><path d="M8 4.8v3.4l2.1 1.2" /></svg>
    case 'tree':
      return <svg {...common}><path d="M4.2 3v10m0-7.5h6.9m-6.9 5h6.9" /><circle cx="4.2" cy="3" r="1" /><circle cx="11.1" cy="5.5" r="1" /><circle cx="11.1" cy="10.5" r="1" /></svg>
    case 'more':
      return <svg {...common} fill="currentColor" stroke="none"><circle cx="3" cy="8" r="1.15" /><circle cx="8" cy="8" r="1.15" /><circle cx="13" cy="8" r="1.15" /></svg>
    case 'pin':
      return <svg {...common}><path d="m5 2.5 6 0 1 3 1.5 1.5v1H9v5.5l-1 1V8H2.5V7L4 5.5z" /></svg>
    case 'history':
      return <svg {...common}><path d="M3.1 6.1A5.4 5.4 0 1 1 2.6 9" /><path d="M2 3.8v3h3M8 4.5v3.8l2.5 1.5" /></svg>
  }
}
