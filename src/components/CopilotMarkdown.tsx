import { Fragment, createElement, useMemo, type ReactNode } from 'react';
import { Lexer, type Token, type Tokens } from 'marked';
import { copilotInlineTokens } from './CopilotInlineText';

function blocks(tokens: Token[]): ReactNode {
  return tokens.map((token, index) => {
    let node: ReactNode;
    switch (token.type) {
      case 'space': case 'def': return null;
      case 'heading': node = createElement(`h${Math.min(6, Math.max(2, token.depth))}`, null, copilotInlineTokens(token.tokens)); break;
      case 'paragraph': node = <p>{copilotInlineTokens(token.tokens)}</p>; break;
      case 'text': node = token.tokens ? copilotInlineTokens(token.tokens) : token.text; break;
      case 'list': {
        const list = token as Tokens.List;
        const items = list.items.map((item, i) => <li key={i}>
          {item.task && <input type="checkbox" checked={Boolean(item.checked)} disabled aria-label={item.checked ? 'Completed item' : 'Incomplete item'} />}
          {blocks(item.tokens)}
        </li>);
        node = list.ordered ? <ol start={Number(list.start) || 1}>{items}</ol> : <ul>{items}</ul>;
        break;
      }
      case 'blockquote': node = <blockquote>{blocks(token.tokens)}</blockquote>; break;
      case 'code': node = <pre tabIndex={0} aria-label="Code block"><code>{token.text}</code></pre>; break;
      case 'hr': node = <hr />; break;
      case 'table': {
        const table = token as Tokens.Table;
        node = <div className="copilot-table-scroll" role="region" aria-label="Response table" tabIndex={0}><table>
          <thead><tr>{table.header.map((cell, i) => <th key={i} scope="col" style={{ textAlign: table.align[i] ?? undefined }}>{copilotInlineTokens(cell.tokens)}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} style={{ textAlign: table.align[j] ?? undefined }}>{copilotInlineTokens(cell.tokens)}</td>)}</tr>)}</tbody>
        </table></div>;
        break;
      }
      default: node = token.raw;
    }
    return <Fragment key={index}>{node}</Fragment>;
  });
}

/** No innerHTML: document/model content cannot create executable markup. */
export function CopilotMarkdown({ text }: { text: string }) {
  const content = useMemo(() => blocks(Lexer.lex(text, { gfm: true, breaks: false })), [text]);
  return <div className="copilot-markdown">{content}</div>;
}
