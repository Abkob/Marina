// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CopilotEvidenceSettings, type EvidenceModelCatalog } from '../../components/CopilotEvidenceSettings';
const roles = ['ocr', 'vision', 'structure', 'reranker'] as const;
const catalog = { defaults: Object.fromEntries(roles.map(role => [role, role])), options: Object.fromEntries(roles.map(role => [role, [{ model: role, label: role }, { model: 'off', label: 'Off' }]])), embeddings: { model: 'gemini', label: 'Gemini', change_requires_reindex: true } } as EvidenceModelCatalog;
describe('document model settings', () => {
  it('offers labelled defaults and preserves other selections on change', () => {
    const onChange = vi.fn();
    render(<CopilotEvidenceSettings catalog={catalog} value={{ vision: 'off' }} disabled={false} onChange={onChange} />);
    expect(screen.getAllByRole('combobox')).toHaveLength(4);
    expect(screen.getByLabelText('Understand images & charts')).toHaveValue('off');
    fireEvent.change(screen.getByLabelText('Read scanned text'), { target: { value: 'off' } });
    expect(onChange).toHaveBeenCalledWith({ vision: 'off', ocr: 'off' });
  });
  it('prevents changing roles during an active reply', () => {
    render(<CopilotEvidenceSettings catalog={catalog} value={{}} disabled onChange={vi.fn()} />);
    for (const select of screen.getAllByRole('combobox')) expect(select).toBeDisabled();
    expect(screen.getByRole('button')).toBeDisabled();
  });
  it('restores defaults and explains embedding migration', () => {
    const onChange = vi.fn();
    render(<CopilotEvidenceSettings catalog={catalog} value={{ ocr: 'off' }} disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button')); expect(onChange).toHaveBeenCalledWith(catalog.defaults);
    expect(screen.getByText(/rebuilding/i)).toBeInTheDocument();
  });
  it('shows a retry path when the catalog cannot load', () => {
    render(<CopilotEvidenceSettings catalog={null} value={{}} disabled={false} onChange={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Reopen/); expect(screen.queryByRole('combobox')).toBeNull();
  });
});
