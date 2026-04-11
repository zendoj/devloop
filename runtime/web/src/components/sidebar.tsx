'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface NavItem {
  href: string;
  label: string;
  icon: string;
  phase: string;
}

const NAV: NavItem[] = [
  { href: '/', label: 'Overview', icon: '◆', phase: 'Fas 1a' },
  { href: '/projects', label: 'Projects', icon: '▢', phase: 'Fas 1b' },
  { href: '/reports', label: 'Reports', icon: '▤', phase: 'Fas 1c' },
  { href: '/tasks', label: 'Tasks', icon: '▣', phase: 'Fas 2' },
  { href: '/deploys', label: 'Deploys', icon: '▲', phase: 'Fas 3' },
  { href: '/health', label: 'Health', icon: '●', phase: 'Fas 3' },
  { href: '/audit', label: 'Audit', icon: '❐', phase: 'Fas 4' },
  { href: '/agents', label: 'Agents', icon: '◈', phase: 'Fas F1' },
  { href: '/db-schema', label: 'DB Schema', icon: '▥', phase: 'Fas E' },
  { href: '/settings', label: 'Settings', icon: '◉', phase: 'Fas 5' },
];

export default function Sidebar(): React.ReactElement {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark">◇</span>
        <span className="sidebar-brand-name">DevLoop</span>
      </div>
      <nav className="sidebar-nav">
        {NAV.map((item) => {
          const active =
            item.href === '/'
              ? pathname === '/'
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`sidebar-link${active ? ' sidebar-link-active' : ''}`}
            >
              <span className="sidebar-link-icon">{item.icon}</span>
              <span className="sidebar-link-label">{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-footer-label">Build</div>
        <div className="sidebar-footer-value">Fas 1a · dev</div>
      </div>
    </aside>
  );
}
