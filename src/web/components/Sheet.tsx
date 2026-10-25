import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface Props {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/** Side sheet from the right: the list behind stays in place. Native <dialog> handles focus trap and Escape. */
export function Sheet({ title, open, onClose, children, footer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  // close() fires the same 'close' event as Escape; only a close by the user may call onClose (it often navigates).
  const closedByProp = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) {
      closedByProp.current = true;
      d.close();
    }
  }, [open]);
  const closed = () => {
    if (closedByProp.current) closedByProp.current = false;
    else onClose();
  };
  return (
    <dialog ref={ref} className="sheet" aria-label={title} onClose={closed} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="sheet-head">
        {/* Focus lands on the title, not the close button, so opening a sheet does not flash a focus ring. */}
        <h2 tabIndex={-1} autoFocus style={{ outline: 'none' }}>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Schließen"><X size={18} /></button>
      </div>
      <div className="sheet-body">{children}</div>
      {footer && <div className="sheet-foot">{footer}</div>}
    </dialog>
  );
}
