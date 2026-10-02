import { memo } from 'react';
import { Streamdown } from 'streamdown';
import { createMathPlugin } from '@streamdown/math';
import 'katex/dist/katex.min.css';
import { safeCopilotHref } from './CopilotInlineText';

const plugins = { math: createMathPlugin({ singleDollarTextMath: true }) };
/** AI Elements' MessageResponse pattern, with Marina's link and image policy. */
export const CopilotMarkdown = memo(function CopilotMarkdown({ text }: { text: string }) {
  return <Streamdown className="copilot-markdown" mode="static" plugins={plugins} controls={false} skipHtml
    rehypePlugins={[]} components={{
      a: ({ href, children }) => {
        const safe = href ? safeCopilotHref(href) : null;
        return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
      },
      img: ({ alt }) => <span>{alt ?? ''}</span>,
      strong: ({ children }) => <strong>{children}</strong>,
      em: ({ children }) => <em>{children}</em>,
      blockquote: ({ children }) => <blockquote>{children}</blockquote>,
      table: ({ children }) => <div className="copilot-table-scroll" role="region" aria-label="Response table" tabIndex={0}><table>{children}</table></div>,
    }}>{text}</Streamdown>;
});
