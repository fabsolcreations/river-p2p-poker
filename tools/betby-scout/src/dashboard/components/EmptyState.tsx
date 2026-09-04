import type { ReactNode } from 'react';

/**
 * Every empty state in this tool answers two questions: what is missing, and
 * what does the user do next. "No data" on its own is a dead end - at Milestone
 * 1 an empty table is the *normal* first experience, and the page has to teach
 * the next step rather than look broken.
 */
export function EmptyState(props: {
  title: string;
  body: ReactNode;
  /** Numbered next steps. Rendered as an ordered list when present. */
  steps?: ReactNode[];
  action?: ReactNode;
  tone?: 'neutral' | 'warning' | 'error';
}): ReactNode {
  const { title, body, steps, action, tone = 'neutral' } = props;
  const border =
    tone === 'error' ? 'border-red-600/60' : tone === 'warning' ? 'border-yellow-600/60' : 'border-dark-600';
  const heading = tone === 'error' ? 'text-red-500' : tone === 'warning' ? 'text-yellow-500' : 'text-white';

  return (
    <div className={`rounded-xl border border-dashed ${border} bg-dark-800/60 px-6 py-8`}>
      <div className="mx-auto max-w-xl">
        <h3 className={`text-sm font-semibold ${heading}`}>{title}</h3>
        <div className="mt-2 text-dark-200">{body}</div>
        {steps && steps.length > 0 && (
          <ol className="mt-4 space-y-1.5 text-dark-200">
            {steps.map((step, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="mt-px inline-flex h-4 w-4 flex-none items-center justify-center rounded bg-dark-600 font-mono text-[10px] tabular-nums text-dark-100">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        )}
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  );
}
