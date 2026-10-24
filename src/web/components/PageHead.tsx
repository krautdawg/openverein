import type { ReactNode } from 'react';

export function PageHead({ title, intro, actions }: { title: ReactNode; intro?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {intro && <p>{intro}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
