import { memo } from 'react';
import { Streamdown } from 'streamdown';
import { createMathPlugin } from '@streamdown/math';
import 'katex/dist/katex.min.css';
import { safeCopilotHref } from './CopilotInlineText';

const plugins = { math: createMathPlugin({ singleDollarTextMath: true }) };
/** Some models mix citation brackets with Markdown. Repair only that complete
 * link shape; preserve fenced/inline code and leave URL validation to the renderer. */
export function normalizeCitationLinks(text: string) {
  return text.split(/(`{3,}[^\n]*\n[\s\S]*?\n`{3,}|~{3,}[^\n]*\n[\s\S]*?\n~{3,}|`+[^\n]*?`+)/g)
    .map((part, index) => index % 2 ? part : part.replace(/【([^【】\[\]\n]{1,500})\]\(([^\s()]{1,2000})\)】/g, '[$1]($2)')).join('');
}
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
    }}>{normalizeCitationLinks(text)}</Streamdown>;
});
