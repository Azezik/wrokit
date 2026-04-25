import type { PropsWithChildren, ReactNode } from 'react';

interface SectionProps extends PropsWithChildren {
  title: ReactNode;
  description?: ReactNode;
  className?: string;
}

export function Section({ title, description, className = '', children }: SectionProps) {
  return (
    <section className={`ui-section ${className}`.trim()}>
      <h2 className="ui-section__header">{title}</h2>
      {description ? <p className="ui-section__subheader">{description}</p> : null}
      {children}
    </section>
  );
}
