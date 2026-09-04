import { useState } from 'react';
import type { ReactNode } from 'react';

import { isSensitiveKey, isSensitiveNumericKey, REDACTED } from '../../shared/redact.ts';
import { jsonType } from '../../shared/shape.ts';
import { truncateEnd } from '../lib/format.ts';

/**
 * Collapsible JSON tree.
 *
 * Three things drive the design:
 *
 * 1. **Bodies are large and untrusted.** A closed node renders nothing, so a
 *    40k-element array costs one row until you open it, and every value is
 *    rendered as text - React escapes it, so a payload containing markup is
 *    shown, not executed.
 * 2. **Wide nodes are capped.** Opening an array of 5,000 objects would freeze
 *    the tab; we render `PAGE` children at a time with an explicit "show more",
 *    and the count of what is hidden is always visible.
 * 3. **Redaction is audited, not assumed.** Redaction runs in the page
 *    (CONTRACT.md rule 5), so by the time a payload reaches this viewer it is
 *    too late to mask anything. What this view *can* do is tell you when a
 *    credential-shaped key arrived with its value intact - which means the
 *    collector had `redact` switched off, and the database now holds a secret.
 */

const PAGE = 100;

export function JsonView(props: {
  value: unknown;
  /** Label for the root node. */
  rootLabel?: string;
  /** Nodes shallower than this start expanded. */
  defaultDepth?: number;
}): ReactNode {
  const { value, rootLabel = 'root', defaultDepth = 2 } = props;
  return (
    <div className="overflow-x-auto rounded-lg border border-dark-600 bg-dark-900/70 p-2 font-mono text-[12px] leading-5">
      <JsonNode label={rootLabel} value={value} depth={0} defaultDepth={defaultDepth} isIndex={false} />
    </div>
  );
}

function JsonNode(props: {
  label: string;
  value: unknown;
  depth: number;
  defaultDepth: number;
  /** True when `label` is an array index, so key-sensitivity rules do not apply. */
  isIndex: boolean;
}): ReactNode {
  const { label, value, depth, defaultDepth, isIndex } = props;
  const type = jsonType(value);
  const [open, setOpen] = useState(depth < defaultDepth);
  const [shown, setShown] = useState(PAGE);

  if (type !== 'obj' && type !== 'arr') {
    return (
      <div className="whitespace-pre-wrap break-words">
        <KeyLabel label={label} isIndex={isIndex} />
        <Leaf label={label} value={value} isIndex={isIndex} />
      </div>
    );
  }

  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);
  const isArray = Array.isArray(value);
  const summary = isArray
    ? `[] ${entries.length} item${entries.length === 1 ? '' : 's'}`
    : `{} ${entries.length} key${entries.length === 1 ? '' : 's'}`;

  const visible = entries.slice(0, shown);
  const hidden = entries.length - visible.length;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-baseline gap-1 rounded px-0.5 text-left hover:bg-dark-700"
        aria-expanded={open}
      >
        <span className="w-3 flex-none text-dark-300">{open ? '▾' : '▸'}</span>
        <KeyLabel label={label} isIndex={isIndex} />
        <span className="text-dark-300">{summary}</span>
      </button>
      {open && (
        <div className="ml-3 border-l border-dark-600 pl-2.5">
          {entries.length === 0 && <div className="text-dark-400">(empty)</div>}
          {visible.map(([k, v], i) => (
            <JsonNode
              key={`${k}:${i}`}
              label={k}
              value={v}
              depth={depth + 1}
              defaultDepth={defaultDepth}
              isIndex={isArray}
            />
          ))}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE * 5)}
              className="mt-1 rounded border border-dark-500 px-1.5 py-0.5 text-[11px] text-dark-100 hover:border-dark-400 hover:bg-dark-700"
            >
              show {Math.min(hidden, PAGE * 5)} more of {hidden} hidden
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function KeyLabel({ label, isIndex }: { label: string; isIndex: boolean }): ReactNode {
  return (
    <span className={isIndex ? 'text-dark-400' : 'text-dark-100'}>
      {isIndex ? `${label}:` : `"${label}":`}{' '}
    </span>
  );
}

/** True for a value the in-page redactor already replaced. */
function looksRedacted(v: string): boolean {
  return v === REDACTED || v.startsWith('[redacted');
}

function Leaf({ label, value, isIndex }: { label: string; value: unknown; isIndex: boolean }): ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-dark-400">null</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="text-purple-500">{String(value)}</span>;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    const risky = !isIndex && isSensitiveNumericKey(label);
    return (
      <>
        <span className="text-blue-500 tabular-nums">{String(value)}</span>
        {risky && <UnredactedWarning kind="number" />}
      </>
    );
  }
  if (typeof value === 'string') {
    if (looksRedacted(value)) {
      return (
        <span
          className="text-yellow-500"
          title="Masked in the page before upload. The key and the value type survived so schema discovery still works."
        >
          &quot;{value}&quot;
        </span>
      );
    }
    const risky = !isIndex && isSensitiveKey(label);
    const shown = truncateEnd(value, 240);
    return (
      <>
        <span className="text-green-500" title={value.length > 240 ? value : undefined}>
          &quot;{shown}&quot;
        </span>
        {value.length > 240 && (
          <span className="ml-1 text-[10px] text-dark-400">({value.length} chars)</span>
        )}
        {risky && <UnredactedWarning kind="string" />}
      </>
    );
  }
  return <span className="text-dark-200">{String(value)}</span>;
}

function UnredactedWarning({ kind }: { kind: 'string' | 'number' }): ReactNode {
  return (
    <span
      className="ml-1.5 rounded-sm border border-red-600 px-1 text-[10px] text-red-500"
      title={`This key matches the redactor's sensitive-key pattern but the ${kind} arrived unmasked. That means the collector uploaded it with redaction off - check Settings, and treat this capture (and any export of it) as containing a secret.`}
    >
      unredacted
    </span>
  );
}

/**
 * Raw-text pane for bodies that are not JSON, or that the reader wants to see
 * verbatim. Kept next to the tree so both are one component's concern.
 */
export function RawView({ text, note }: { text: string; note?: string | null }): ReactNode {
  return (
    <div>
      {note && <p className="mb-1.5 text-[11px] text-dark-300">{note}</p>}
      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-dark-600 bg-dark-900/70 p-2 text-[12px] leading-5 text-dark-100">
        {text}
      </pre>
    </div>
  );
}
