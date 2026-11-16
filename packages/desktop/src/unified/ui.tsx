import {useEffect, useRef, type ButtonHTMLAttributes, type ReactNode} from 'react';

/** Shared shell controls use the proposal's tokens and native keyboard semantics. */
export function Button({variant = 'primary', className = '', type = 'button', ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {variant?: 'primary' | 'secondary' | 'ghost'}) {
  return <button {...props} type={type} className={`${variant === 'primary' ? '' : variant} ${className}`.trim()} />;
}

export function Notice({children, urgent = true}: {children: ReactNode; urgent?: boolean}) {
  return <div className="notice" role={urgent ? 'alert' : 'status'}>{children}</div>;
}

export function ShellDialog({children, labelledBy, className, onClose, initialFocus}: {children: ReactNode; labelledBy: string; className?: string; onClose(): void; initialFocus?: string}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement, modal = dialog.current!;
    modal.showModal();
    if (initialFocus) modal.querySelector<HTMLElement>(initialFocus)?.focus();
    return () => {modal.close(); if (previous instanceof HTMLElement && previous.isConnected && !previous.closest('[inert]')) previous.focus();};
  }, [initialFocus]);
  return <dialog ref={dialog} className={className} aria-labelledby={labelledBy}
    onCancel={event => {event.preventDefault(); onClose();}}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>{children}</dialog>;
}

/** Consistent, left-aligned guidance for empty pages and missing prerequisites. */
export function EmptyState({title, children, action}: {title: string; children: ReactNode; action?: ReactNode}) {
  return <section className="empty-state panel"><h2>{title}</h2><p>{children}</p>{action ? <div className="empty-actions">{action}</div> : null}</section>;
}
