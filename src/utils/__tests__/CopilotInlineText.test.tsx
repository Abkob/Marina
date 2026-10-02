// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CopilotInlineText } from '../../components/CopilotInlineText';

describe('Copilot inline citations', () => {
  it('opens a cited Drive source safely and preserves the page label', () => {
    render(<CopilotInlineText text="Read [Study guide, p. 1](https://drive.google.com/file/d/file-123/view)." />);
    expect(screen.getByRole('link', { name: 'Study guide, p. 1' })).toHaveAttribute('href', 'https://drive.google.com/file/d/file-123/view');
    expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
  });
  it('keeps local file citations available', () => {
    render(<CopilotInlineText text="[Original, p. 4](/api/resources/blob/resource-1#page=4)" />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/api/resources/blob/resource-1#page=4');
  });
  it.each(['javascript:alert', 'data:text/html,evil', '//evil.test', '/api/backups/delete', 'https://user:password@evil.test'])('leaves unsafe or unrelated URL %s as inert text', href => {
    const text = `[source](${href})`;
    render(<CopilotInlineText text={text} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(text)).toBeInTheDocument();
  });
  it('preserves emphasis and literal code without turning code into links or HTML', () => {
    const { container } = render(<CopilotInlineText text={'**Title** `<img src=x>` `[code](https://example.com)`'} />);
    expect(container.querySelector('strong')).toHaveTextContent('Title');
    expect(container.querySelectorAll('code')).toHaveLength(2);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
