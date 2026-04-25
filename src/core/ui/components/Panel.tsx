import type { PropsWithChildren } from 'react';

interface PanelProps extends PropsWithChildren {
  className?: string;
  as?: 'div' | 'aside' | 'section';
}

export function Panel({ as = 'div', className = '', children }: PanelProps) {
  const Component = as;
  return <Component className={`ui-panel ${className}`.trim()}>{children}</Component>;
}
