import { Fragment, type ReactNode } from 'react';
import { Lexer, type Token } from 'marked';

export function safeCopilotHref(value: string): string | null {
  if (/^\/api\/resources\/blob\/[\w-]+(?:#page=\d+)?$/.test(value)) return value;
  if (!/^https?:\/\//i.test(value) || /[\s<>\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url.href;
  } catch { return null; }
}

/** Tokenize Markdown, but create React nodes only: raw HTML and images stay inert. */
export function copilotInlineTokens(tokens: Token[]): ReactNode {
  return tokens.map((token, index) => {
    const children = () => copilotInlineTokens('tokens' in token ? token.tokens ?? [] : []);
    let node: ReactNode;
    switch (token.type) {
      case 'strong': node = <strong>{children()}</strong>; break;
      case 'em': node = <em>{children()}</em>; break;
      case 'del': node = <del>{children()}</del>; break;
      case 'codespan': node = <code>{token.text}</code>; break;
      case 'br': node = <br />; break;
      case 'link': {
        const href = safeCopilotHref(token.href);
        node = href ? <a href={href} target="_blank" rel="noopener noreferrer">{children()}</a> : token.raw;
        break;
      }
      case 'text': node = token.tokens ? children() : token.text; break;
      case 'escape': node = token.text; break;
      default: node = token.raw;
    }
    return <Fragment key={index}>{node}</Fragment>;
  });
}

export function CopilotInlineText({ text }: { text: string }) {
  return <>{copilotInlineTokens(Lexer.lexInline(text, { gfm: true, breaks: false }))}</>;
}
