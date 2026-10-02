// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CopilotMarkdown } from '../../components/CopilotMarkdown';

describe('Copilot answer formatting', () => {
  it('formats the screenshot’s italics, nested emphasis and numbered tasks as semantic Markdown', () => {
    const { container } = render(<CopilotMarkdown text={'In *Introduction to Algebra*:\n\n1. **Database refresh** — Goal: *PosSystem* — Status: *todo*\n2. **Fix errors** — **Read *carefully***\n   - Keep the filename ma463_Introduction unchanged.\n\nNext paragraph.'} />);
    expect(container.querySelector('em')).toHaveTextContent('Introduction to Algebra');
    expect(container.querySelector('ol')?.children).toHaveLength(2);
    expect(container.querySelector('ol ul li')).toHaveTextContent('ma463_Introduction');
    expect(container.querySelector('strong em')).toHaveTextContent('carefully');
    expect(container.textContent).not.toContain('*todo*');
  });
  it('retains ordered-list starts, inline formatting in headings and table structure', () => {
    const { container } = render(<CopilotMarkdown text={'## Read *this*\n\n4. Fourth\n5. Fifth\n\n| Topic | Page |\n| --- | ---: |\n| **Logic** | 94 |'} />);
    expect(screen.getByRole('heading', { name: 'Read this' })).toBeInTheDocument();
    expect(container.querySelector('h2 em')).toHaveTextContent('this');
    expect(screen.getByRole('list')).toHaveAttribute('start', '4');
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Response table' })).toHaveAttribute('tabindex', '0');
  });
  it('preserves code, mathematical Unicode, paragraphs and quoted text', () => {
    const { container } = render(<CopilotMarkdown text={'a ≡ 0 (mod n), P ⇒ Q\n\n> Quoted **evidence**\n\n```ts\nconst a = "<script>";\n```'} />);
    expect(container.querySelector('blockquote strong')).toHaveTextContent('evidence');
    expect(container.querySelector('pre code')).toHaveTextContent('const a = "<script>";');
    expect(container.textContent).toContain('P ⇒ Q');
    expect(container.querySelector('script')).toBeNull();
  });
  it('never executes HTML, images or unsafe links from model/document text', () => {
    const { container } = render(<CopilotMarkdown text={'<script>alert(1)</script>\n\n<img src="https://tracking.test/pixel" onerror="alert(1)">\n\n![image](https://tracking.test/pixel) [bad](javascript:alert) [file](/api/resources/blob/book#page=94)'} />);
    expect(container.querySelector('img, script, iframe')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/api/resources/blob/book#page=94');
    expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
