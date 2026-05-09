import { NavLink } from 'react-router-dom';

type NavItem = { to: string; label: string };

const items: NavItem[] = [
  { to: '/', label: '새 작업' },
  { to: '/history', label: '히스토리' },
  { to: '/settings', label: '설정' },
];

export function Sidebar() {
  return (
    <nav
      aria-label="주 내비게이션"
      className="gap-xxs border-hairline-soft bg-canvas px-md py-xl flex w-[220px] shrink-0 flex-col border-r"
    >
      <div className="mb-md px-md py-xs text-card-title font-semibold">Shorts AI</div>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) =>
            `px-md py-xs text-body-sm block rounded-sm ${
              isActive ? 'bg-surface text-ink font-medium' : 'text-charcoal bg-transparent'
            }`
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
