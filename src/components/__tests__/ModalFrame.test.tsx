// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModalFrame } from '../ModalFrame';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('does not move focus out of an input when its parent rerenders', () => {
  const { rerender } = render(<ModalFrame titleId="title" onClose={() => {}} className=""><h2 id="title">Edit</h2><button>Close</button><input aria-label="Title" /></ModalFrame>);
  const input = screen.getByLabelText('Title');
  input.focus();
  rerender(<ModalFrame titleId="title" onClose={() => {}} className=""><h2 id="title">Edit</h2><button>Close</button><input aria-label="Title" /></ModalFrame>);
  expect(document.activeElement).toBe(input);
});

it('only dismisses the top dialog and keeps the background locked', () => {
  const closeParent = vi.fn(), closeChild = vi.fn();
  const parent = render(<ModalFrame titleId="p" onClose={closeParent} className=""><h2 id="p">Parent</h2><button>Parent action</button></ModalFrame>);
  const child = render(<ModalFrame titleId="c" onClose={closeChild} className=""><h2 id="c">Child</h2><button>Child action</button></ModalFrame>);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(closeChild).toHaveBeenCalledTimes(1);
  expect(closeParent).not.toHaveBeenCalled();
  child.unmount();
  expect(document.body.style.overflow).toBe('hidden');
  parent.unmount();
  expect(document.body.style.overflow).toBe('');
});

it('keeps iPhone page scroll locked until the last sheet closes', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const original = Object.getOwnPropertyDescriptor(window, 'scrollY');
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 420 });
  const parent = render(<ModalFrame titleId="p" onClose={() => {}} className=""><h2 id="p">Parent</h2></ModalFrame>);
  const child = render(<ModalFrame titleId="c" onClose={() => {}} className=""><h2 id="c">Child</h2></ModalFrame>);
  expect(document.body.style.position).toBe('fixed');
  expect(document.body.style.top).toBe('-420px');
  child.unmount();
  expect(document.body.style.position).toBe('fixed');
  parent.unmount();
  expect(document.body.style.position).toBe('');
  expect(document.body.style.top).toBe('');
  expect(scrollTo).toHaveBeenCalledWith({ top: 420, behavior: 'instant' });
  if (original) Object.defineProperty(window, 'scrollY', original);
});
