import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './icon-button.js';
import { useI18n } from '../../lib/i18n/index.js';

export function ActionsMenu({
  children,
  label,
  portal = false,
}: {
  children: ReactNode;
  label?: string;
  portal?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const name = label ?? t('common.actions');
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open || !portal) return;
    const updatePosition = () => {
      // Both refs are attached while the portaled menu is open, which is when this runs.
      const anchor = trigger.current!.getBoundingClientRect();
      const menu = panel.current!.getBoundingClientRect();
      const top =
        anchor.bottom + menu.height + 4 <= window.innerHeight
          ? anchor.bottom + 4
          : Math.max(8, anchor.top - menu.height - 4);
      setPosition({
        position: 'fixed',
        top,
        left: Math.max(8, Math.min(anchor.right - menu.width, window.innerWidth - menu.width - 8)),
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, portal]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !panel.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const menuPanel = (
    <div
      ref={panel}
      id={id}
      role="menu"
      aria-label={name}
      hidden={!open}
      className={`entity-actions-menu ${portal ? 'z-[1000] min-w-56 rounded-md border border-border bg-surface-1 py-1 shadow-xl' : 'absolute right-0 top-full z-40 mt-1 min-w-56 rounded-md border border-border bg-surface-1 py-1 shadow-xl'}`}
      style={portal ? position : undefined}
      onClick={(event) => {
        if (
          panel.current?.contains(event.target as Node) &&
          (event.target as HTMLElement).closest('button:not(:disabled)')
        )
          close();
      }}
      onKeyDown={(event) => {
        if (!event.currentTarget.contains(event.target as Node)) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        ];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}
    >
      {children}
    </div>
  );
  return (
    <div
      ref={root}
      data-actions-menu
      className="relative inline-flex shrink-0"
      onBlur={(event) => {
        if (
          !event.currentTarget.contains(event.relatedTarget) &&
          !panel.current?.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
    >
      <IconButton
        ref={trigger}
        label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        icon={<i className="ti ti-dots-vertical text-lg" aria-hidden="true" />}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      />
      {portal && typeof document !== 'undefined'
        ? createPortal(menuPanel, document.body)
        : menuPanel}
    </div>
  );
}
